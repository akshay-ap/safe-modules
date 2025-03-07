import { expect } from 'chai'
import { deployments, ethers, network } from 'hardhat'
import { bundlerRpc, prepareAccounts, waitForUserOp } from '../utils/e2e'
import { chainId } from '../utils/encoding'
import {
  UserVerificationRequirement,
  WebAuthnCredentials,
  extractClientDataFields,
  extractPublicKey,
  extractSignature,
} from '../utils/webauthn'
import { packGasParameters, unpackUserOperation } from '../../src/utils/userOp'

describe('E2E - WebAuthn Signers', () => {
  before(function () {
    if (network.name !== 'localhost') {
      this.skip()
    }
  })

  const setupTests = deployments.createFixture(async ({ deployments }) => {
    const { EntryPoint, Safe4337Module, SafeSignerLaunchpad, SafeProxyFactory, SafeModuleSetup, SafeL2, WebAuthnVerifier } =
      await deployments.run()
    const [user] = await prepareAccounts()
    const bundler = bundlerRpc()

    const entryPoint = await ethers.getContractAt('IEntryPoint', EntryPoint.address)
    const module = await ethers.getContractAt('Safe4337Module', Safe4337Module.address)
    const proxyFactory = await ethers.getContractAt('SafeProxyFactory', SafeProxyFactory.address)
    const safeModuleSetup = await ethers.getContractAt('SafeModuleSetup', SafeModuleSetup.address)
    const signerLaunchpad = await ethers.getContractAt('SafeSignerLaunchpad', SafeSignerLaunchpad.address)
    const singleton = await ethers.getContractAt('SafeL2', SafeL2.address)
    const webAuthnVerifier = await ethers.getContractAt('WebAuthnVerifier', WebAuthnVerifier.address)

    const WebAuthnSignerFactory = await ethers.getContractFactory('WebAuthnSignerFactory')
    const signerFactory = await WebAuthnSignerFactory.deploy()

    const navigator = {
      credentials: new WebAuthnCredentials(),
    }

    return {
      user,
      bundler,
      proxyFactory,
      safeModuleSetup,
      module,
      entryPoint,
      signerLaunchpad,
      singleton,
      signerFactory,
      navigator,
      webAuthnVerifier,
    }
  })

  it('should execute a user op and deploy a WebAuthn signer', async () => {
    const {
      user,
      bundler,
      proxyFactory,
      safeModuleSetup,
      module,
      entryPoint,
      signerLaunchpad,
      singleton,
      signerFactory,
      navigator,
      webAuthnVerifier,
    } = await setupTests()
    const webAuthnVerifierAddress = await webAuthnVerifier.getAddress()

    const credential = navigator.credentials.create({
      publicKey: {
        rp: {
          name: 'Safe',
          id: 'safe.global',
        },
        user: {
          id: ethers.getBytes(ethers.id('chucknorris')),
          name: 'chucknorris',
          displayName: 'Chuck Norris',
        },
        challenge: ethers.toBeArray(Date.now()),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      },
    })
    const publicKey = extractPublicKey(credential.response)
    const signerData = ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'uint256', 'address'],
      [publicKey.x, publicKey.y, webAuthnVerifierAddress],
    )
    const signerAddress = await signerFactory.getSigner(signerData)

    const safeInit = {
      singleton: singleton.target,
      signerFactory: signerFactory.target,
      signerData,
      setupTo: safeModuleSetup.target,
      setupData: safeModuleSetup.interface.encodeFunctionData('enableModules', [[module.target]]),
      fallbackHandler: module.target,
    }
    const safeInitHash = ethers.TypedDataEncoder.hash(
      { verifyingContract: await signerLaunchpad.getAddress(), chainId: await chainId() },
      {
        SafeInit: [
          { type: 'address', name: 'singleton' },
          { type: 'address', name: 'signerFactory' },
          { type: 'bytes', name: 'signerData' },
          { type: 'address', name: 'setupTo' },
          { type: 'bytes', name: 'setupData' },
          { type: 'address', name: 'fallbackHandler' },
        ],
      },
      safeInit,
    )

    expect(
      await signerLaunchpad.getInitHash(
        safeInit.singleton,
        safeInit.signerFactory,
        safeInit.signerData,
        safeInit.setupTo,
        safeInit.setupData,
        safeInit.fallbackHandler,
      ),
    ).to.equal(safeInitHash)

    const launchpadInitializer = signerLaunchpad.interface.encodeFunctionData('preValidationSetup', [
      safeInitHash,
      ethers.ZeroAddress,
      '0x',
    ])
    const safeSalt = Date.now()
    const safe = await proxyFactory.createProxyWithNonce.staticCall(signerLaunchpad.target, launchpadInitializer, safeSalt)

    const packedUserOp = {
      sender: safe,
      nonce: ethers.toBeHex(await entryPoint.getNonce(safe, 0)),
      initCode: ethers.solidityPacked(
        ['address', 'bytes'],
        [
          proxyFactory.target,
          proxyFactory.interface.encodeFunctionData('createProxyWithNonce', [signerLaunchpad.target, launchpadInitializer, safeSalt]),
        ],
      ),
      callData: signerLaunchpad.interface.encodeFunctionData('initializeThenUserOp', [
        safeInit.singleton,
        safeInit.signerFactory,
        safeInit.signerData,
        safeInit.setupTo,
        safeInit.setupData,
        safeInit.fallbackHandler,
        module.interface.encodeFunctionData('executeUserOp', [user.address, ethers.parseEther('0.5'), '0x', 0]),
      ]),
      preVerificationGas: ethers.toBeHex(60000),
      ...packGasParameters({
        verificationGasLimit: 500000,
        callGasLimit: 2000000,
        maxFeePerGas: 10000000000,
        maxPriorityFeePerGas: 10000000000,
      }),
      paymasterAndData: '0x',
    }

    const safeInitOp = {
      userOpHash: await entryPoint.getUserOpHash({ ...packedUserOp, signature: '0x' }),
      validAfter: 0,
      validUntil: 0,
      entryPoint: entryPoint.target,
    }
    const safeInitOpHash = ethers.TypedDataEncoder.hash(
      { verifyingContract: await signerLaunchpad.getAddress(), chainId: await chainId() },
      {
        SafeInitOp: [
          { type: 'bytes32', name: 'userOpHash' },
          { type: 'uint48', name: 'validAfter' },
          { type: 'uint48', name: 'validUntil' },
          { type: 'address', name: 'entryPoint' },
        ],
      },
      safeInitOp,
    )

    const assertion = navigator.credentials.get({
      publicKey: {
        challenge: ethers.getBytes(safeInitOpHash),
        rpId: 'safe.global',
        allowCredentials: [{ type: 'public-key', id: new Uint8Array(credential.rawId) }],
        userVerification: UserVerificationRequirement.required,
      },
    })
    const signature = ethers.solidityPacked(
      ['uint48', 'uint48', 'bytes'],
      [
        safeInitOp.validAfter,
        safeInitOp.validUntil,
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['bytes', 'bytes', 'uint256[2]'],
          [
            new Uint8Array(assertion.response.authenticatorData),
            extractClientDataFields(assertion.response),
            extractSignature(assertion.response),
          ],
        ),
      ],
    )

    await user.sendTransaction({ to: safe, value: ethers.parseEther('1') }).then((tx) => tx.wait())
    expect(await ethers.provider.getBalance(safe)).to.equal(ethers.parseEther('1'))
    expect(await ethers.provider.getCode(safe)).to.equal('0x')
    expect(await ethers.provider.getCode(signerAddress)).to.equal('0x')

    const userOp = await unpackUserOperation({ ...packedUserOp, signature })
    await bundler.sendUserOperation(userOp, await entryPoint.getAddress())

    await waitForUserOp(userOp)
    expect(await ethers.provider.getBalance(safe)).to.be.lessThanOrEqual(ethers.parseEther('0.5'))
    expect(await ethers.provider.getCode(safe)).to.not.equal('0x')
    expect(await ethers.provider.getCode(signerAddress)).to.not.equal('0x')

    const [implementation] = ethers.AbiCoder.defaultAbiCoder().decode(['address'], await ethers.provider.getStorage(safe, 0))
    expect(implementation).to.equal(singleton.target)

    const safeInstance = await ethers.getContractAt('SafeL2', safe)
    expect(await safeInstance.getOwners()).to.deep.equal([signerAddress])
  })
})
