import { expect } from "chai";
import { readFile } from "node:fs/promises";
import { network } from "hardhat";
import { Transaction, Wallet, getCreateAddress, keccak256 } from "ethers";
import {
  parseLoyaltyDeploymentJournal,
  type LoyaltyDeploymentJournal,
} from "../scripts/deploy-loyalty-multibaas.js";
const { ethers } = await network.create({ override: { chainId: 11155111 } });

describe("Loyalty-only deployment journal recovery", () => {
  it("verifies a real signed reward creation and rejects journal changes before resuming", async () => {
    const [administrator] = await ethers.getSigners();
    const signer = Wallet.createRandom().connect(ethers.provider);
    await administrator.sendTransaction({
      to: signer.address,
      value: ethers.parseEther("1"),
    });
    const token = await ethers.deployContract("MatsuriStablecoin", [
      "Matsuri Yen",
      "MJPY",
      administrator.address,
    ]);
    const factory = await ethers.getContractFactory("LoyaltyPoints", signer);
    const unsigned = await signer.populateTransaction(
      await factory.getDeployTransaction(
        await token.getAddress(),
        administrator.address,
      ),
    );
    const signedTx = await signer.signTransaction(unsigned);
    const tx = Transaction.from(signedTx);
    const journal: LoyaltyDeploymentJournal = {
      format: "suica-loyalty-deployment-v1",
      chainId: "11155111",
      multibaasUrl: "https://multibaas.example",
      keyId: "local-evm-signer",
      deployer: signer.address.toLowerCase(),
      administrator: administrator.address.toLowerCase(),
      tokenAddress: (await token.getAddress()).toLowerCase(),
      label: "loyaltypoints",
      version: "1.0.0",
      createdAt: new Date().toISOString(),
      loyalty: {
        address: getCreateAddress({
          from: signer.address,
          nonce: tx.nonce,
        }).toLowerCase(),
        transactionHash: tx.hash!,
        nonce: String(tx.nonce),
        signedTx,
        calldataHash: keccak256(tx.data),
        status: "signed",
        signedAt: new Date().toISOString(),
      },
    };
    expect(
      parseLoyaltyDeploymentJournal(journal).loyalty!.transactionHash,
    ).to.equal(tx.hash);
    for (const changed of [
      { transactionHash: ethers.ZeroHash },
      { calldataHash: ethers.ZeroHash },
      { nonce: String(tx.nonce + 1) },
      { address: administrator.address },
      { status: "confirmed" },
    ]) {
      expect(() =>
        parseLoyaltyDeploymentJournal({
          ...journal,
          loyalty: { ...journal.loyalty, ...changed },
        }),
      ).to.throw();
    }
    expect(() =>
      parseLoyaltyDeploymentJournal({ ...journal, chainId: "6497" }),
    ).to.throw();
    expect(() =>
      parseLoyaltyDeploymentJournal({
        ...journal,
        tokenAddress: ethers.ZeroAddress,
      }),
    ).to.throw();
    const receipt = await (
      await ethers.provider.broadcastTransaction(signedTx)
    ).wait();
    expect(receipt!.status).to.equal(1);
    journal.loyalty!.status = "confirmed";
    journal.loyalty!.blockNumber = String(receipt!.blockNumber);
    journal.loyalty!.blockHash = receipt!.blockHash;
    expect(parseLoyaltyDeploymentJournal(journal).loyalty!.status).to.equal(
      "confirmed",
    );
    const deployed = await ethers.getContractAt(
      "LoyaltyPoints",
      receipt!.contractAddress!,
    );
    expect(await deployed.token()).to.equal(await token.getAddress());
    expect(await deployed.owner()).to.equal(administrator.address);
  });
  it("preserves deployed collectible bytecode and keeps loyalty below EIP-170", async () => {
    const collectible = JSON.parse(
      await readFile(
        new URL(
          "../artifacts/src/CollectibleRewards.sol/CollectibleRewards.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(keccak256(collectible.bytecode)).eq(
      "0x179d7702a1f0bcfee96c64c27bccbcaf1460d029ebd13096d443067afcde27d9",
    );
    const loyalty = JSON.parse(
      await readFile(
        new URL(
          "../artifacts/src/LoyaltyPoints.sol/LoyaltyPoints.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect((loyalty.deployedBytecode.length - 2) / 2).lessThan(24576);
  });
});
