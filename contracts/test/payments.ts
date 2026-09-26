import { expect } from 'chai';
import { network } from 'hardhat';

const { ethers } = await network.create();
const merchantId = ethers.id('registered-merchant');
const invoiceId = ethers.id('first-invoice');
const amount = ethers.parseUnits('500', 18);

async function fixture() {
  const [owner, payer, recipient, other] = await ethers.getSigners();
  const token = await ethers.deployContract('MatsuriStablecoin', ['Matsuri Yen', 'MJPY', owner.address]);
  await token.waitForDeployment();
  const router = await ethers.deployContract('DemoPayments', [await token.getAddress(), owner.address]);
  await router.waitForDeployment();
  await router.setMerchant(merchantId, recipient.address, true);
  await token.mint(payer.address, ethers.parseUnits('3000', 18));
  await token.connect(payer).approve(await router.getAddress(), ethers.parseUnits('3000', 18));
  const block = await ethers.provider.getBlock('latest');
  const deadline = block!.timestamp + 3600;
  return { owner, payer, recipient, other, token, router, deadline };
}

describe('DemoPayments with real MatsuriStablecoin', () => {
  it('atomically moves MJPY, consumes allowance, and emits only payment data', async () => {
    const { payer, recipient, token, router, deadline } = await fixture();
    await expect(router.connect(payer).pay(invoiceId, merchantId, amount, deadline))
      .to.emit(router, 'PaymentCompleted')
      .withArgs(invoiceId, merchantId, payer.address, recipient.address, await token.getAddress(), amount);
    expect(await token.balanceOf(payer.address)).to.equal(ethers.parseUnits('2500', 18));
    expect(await token.balanceOf(recipient.address)).to.equal(amount);
    expect(await token.allowance(payer.address, await router.getAddress())).to.equal(ethers.parseUnits('2500', 18));
    expect(await router.settled(payer.address, invoiceId)).to.equal(true);
  });

  it('rejects a duplicate even if amount or merchant changes', async () => {
    const { payer, recipient, token, router, deadline } = await fixture();
    await router.connect(payer).pay(invoiceId, merchantId, amount, deadline);
    const secondMerchant = ethers.id('another-merchant');
    await router.setMerchant(secondMerchant, recipient.address, true);
    await expect(router.connect(payer).pay(invoiceId, secondMerchant, 1n, deadline))
      .to.be.revertedWithCustomError(router, 'InvoiceAlreadySettled');
    expect(await token.balanceOf(recipient.address)).to.equal(amount);
  });

  it('does not let a different payer consume the original payer invoice', async () => {
    const { payer, other, recipient, token, router, deadline } = await fixture();
    await token.mint(other.address, amount);
    await token.connect(other).approve(await router.getAddress(), amount);
    await router.connect(other).pay(invoiceId, merchantId, amount, deadline);
    expect(await router.settled(payer.address, invoiceId)).to.equal(false);
    await router.connect(payer).pay(invoiceId, merchantId, amount, deadline);
    expect(await token.balanceOf(recipient.address)).to.equal(amount * 2n);
  });

  it('rejects expired, zero-amount, and zero-ID invoices', async () => {
    const { payer, router } = await fixture();
    const block = await ethers.provider.getBlock('latest');
    await expect(router.connect(payer).pay(invoiceId, merchantId, amount, block!.timestamp - 1))
      .to.be.revertedWithCustomError(router, 'InvoiceExpired');
    await expect(router.connect(payer).pay(invoiceId, merchantId, 0n, block!.timestamp + 1000))
      .to.be.revertedWithCustomError(router, 'InvalidAmount');
    await expect(router.connect(payer).pay(ethers.ZeroHash, merchantId, amount, block!.timestamp + 1000))
      .to.be.revertedWithCustomError(router, 'InvalidInvoice');
    expect(await router.settled(payer.address, invoiceId)).to.equal(false);
  });

  it('permits settlement at the exact deadline and rejects the next second', async () => {
    const { payer, router, deadline } = await fixture();
    await ethers.provider.send('evm_setNextBlockTimestamp', [deadline]);
    await router.connect(payer).pay(invoiceId, merchantId, amount, deadline);
    await expect(router.connect(payer).pay(ethers.id('expired'), merchantId, amount, deadline))
      .to.be.revertedWithCustomError(router, 'InvoiceExpired');
  });

  it('rejects unknown and disabled merchants without consuming the invoice', async () => {
    const { payer, recipient, router, deadline } = await fixture();
    await expect(router.connect(payer).pay(invoiceId, ethers.id('unknown'), amount, deadline))
      .to.be.revertedWithCustomError(router, 'MerchantDisabled');
    await router.setMerchant(merchantId, recipient.address, false);
    await expect(router.connect(payer).pay(invoiceId, merchantId, amount, deadline))
      .to.be.revertedWithCustomError(router, 'MerchantDisabled');
    expect(await router.settled(payer.address, invoiceId)).to.equal(false);
  });

  it('prevents recipient changes for pending invoices, including after disabling a merchant', async () => {
    const { payer, recipient, other, token, router, deadline } = await fixture();
    await expect(router.setMerchant(merchantId, other.address, true))
      .to.be.revertedWithCustomError(router, 'MerchantRecipientImmutable');
    await router.setMerchant(merchantId, recipient.address, false);
    await expect(router.setMerchant(merchantId, other.address, false))
      .to.be.revertedWithCustomError(router, 'MerchantRecipientImmutable');
    await router.setMerchant(merchantId, recipient.address, true);
    await router.connect(payer).pay(invoiceId, merchantId, amount, deadline);
    expect(await token.balanceOf(recipient.address)).to.equal(amount);
    expect(await token.balanceOf(other.address)).to.equal(0n);
    const newMerchant = ethers.id('new-recipient-merchant');
    await router.setMerchant(newMerchant, other.address, true);
    await router.connect(payer).pay(ethers.id('new-recipient-invoice'), newMerchant, amount, deadline);
    expect(await token.balanceOf(other.address)).to.equal(amount);
  });

  it('rolls back invoice state when allowance is insufficient, allowing a funded retry', async () => {
    const { payer, recipient, token, router, deadline } = await fixture();
    await token.connect(payer).approve(await router.getAddress(), amount - 1n);
    await expect(router.connect(payer).pay(invoiceId, merchantId, amount, deadline))
      .to.be.revertedWithCustomError(token, 'ERC20InsufficientAllowance');
    expect(await router.settled(payer.address, invoiceId)).to.equal(false);
    expect(await token.balanceOf(recipient.address)).to.equal(0n);
    await token.connect(payer).approve(await router.getAddress(), amount);
    await router.connect(payer).pay(invoiceId, merchantId, amount, deadline);
    expect(await router.settled(payer.address, invoiceId)).to.equal(true);
  });

  it('rolls back invoice and allowance when balance is insufficient', async () => {
    const { payer, recipient, token, router, deadline } = await fixture();
    await token.burn(payer.address, ethers.parseUnits('3000', 18));
    await expect(router.connect(payer).pay(invoiceId, merchantId, amount, deadline))
      .to.be.revertedWithCustomError(token, 'ERC20InsufficientBalance');
    expect(await router.settled(payer.address, invoiceId)).to.equal(false);
    expect(await token.balanceOf(recipient.address)).to.equal(0n);
    expect(await token.allowance(payer.address, await router.getAddress())).to.equal(ethers.parseUnits('3000', 18));
  });

  it('restricts merchant administration, issuer minting, and issuer burning', async () => {
    const { payer, recipient, token, router } = await fixture();
    await expect(router.connect(payer).setMerchant(merchantId, payer.address, true))
      .to.be.revertedWithCustomError(router, 'OwnableUnauthorizedAccount').withArgs(payer.address);
    await expect(token.connect(payer).mint(payer.address, 1n))
      .to.be.revertedWithCustomError(token, 'OwnableUnauthorizedAccount').withArgs(payer.address);
    await expect(token.connect(payer).burn(recipient.address, 1n))
      .to.be.revertedWithCustomError(token, 'OwnableUnauthorizedAccount').withArgs(payer.address);
  });

  it('requires the new router owner to accept ownership', async () => {
    const { owner, payer, recipient, router } = await fixture();
    await router.transferOwnership(payer.address);
    expect(await router.owner()).to.equal(owner.address);
    await router.connect(payer).acceptOwnership();
    await expect(router.setMerchant(merchantId, recipient.address, false))
      .to.be.revertedWithCustomError(router, 'OwnableUnauthorizedAccount');
    await router.connect(payer).setMerchant(merchantId, recipient.address, false);
  });

  it('validates token code and merchant recipient configuration', async () => {
    const { owner, payer, recipient, router } = await fixture();
    const factory = await ethers.getContractFactory('DemoPayments');
    await expect(factory.deploy(ethers.ZeroAddress, owner.address))
      .to.be.revertedWithCustomError(router, 'InvalidToken');
    await expect(factory.deploy(payer.address, owner.address))
      .to.be.revertedWithCustomError(router, 'InvalidToken');
    await expect(router.setMerchant(ethers.ZeroHash, recipient.address, true))
      .to.be.revertedWithCustomError(router, 'InvalidMerchant');
    await expect(router.setMerchant(merchantId, ethers.ZeroAddress, true))
      .to.be.revertedWithCustomError(router, 'InvalidRecipient');
    await expect(router.setMerchant(merchantId, await router.getAddress(), true))
      .to.be.revertedWithCustomError(router, 'InvalidRecipient');
  });
});
