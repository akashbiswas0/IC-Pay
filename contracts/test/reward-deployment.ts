import { expect } from "chai";
import { readFile } from "node:fs/promises";
import { network } from "hardhat";
import { Transaction, Wallet, getCreateAddress, keccak256 } from "ethers";
import {
  parseRewardDeploymentJournal,
  type RewardDeploymentJournal,
} from "../scripts/deploy-rewards-multibaas.js";
const { ethers } = await network.create({ override: { chainId: 11155111 } });

describe("Reward-only deployment recovery and legacy compatibility", () => {
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
    const factory = await ethers.getContractFactory("RewardPayments", signer);
    const unsigned = await signer.populateTransaction(
      await factory.getDeployTransaction(
        await token.getAddress(),
        administrator.address,
      ),
    );
    const signedTx = await signer.signTransaction(unsigned);
    const tx = Transaction.from(signedTx);
    const journal: RewardDeploymentJournal = {
      format: "suica-reward-deployment-v1",
      chainId: "11155111",
      multibaasUrl: "https://multibaas.example",
      keyId: "local-evm-signer",
      deployer: signer.address.toLowerCase(),
      administrator: administrator.address.toLowerCase(),
      tokenAddress: (await token.getAddress()).toLowerCase(),
      label: "rewardpayments",
      version: "1.0.0",
      createdAt: new Date().toISOString(),
      reward: {
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
      parseRewardDeploymentJournal(journal).reward!.transactionHash,
    ).to.equal(tx.hash);
    for (const changed of [
      { transactionHash: ethers.ZeroHash },
      { calldataHash: ethers.ZeroHash },
      { nonce: String(tx.nonce + 1) },
      { address: administrator.address },
      { status: "confirmed" },
    ]) {
      expect(() =>
        parseRewardDeploymentJournal({
          ...journal,
          reward: { ...journal.reward, ...changed },
        }),
      ).to.throw();
    }
    expect(() =>
      parseRewardDeploymentJournal({ ...journal, chainId: "6497" }),
    ).to.throw();
    expect(() =>
      parseRewardDeploymentJournal({
        ...journal,
        tokenAddress: ethers.ZeroAddress,
      }),
    ).to.throw();
    const receipt = await (
      await ethers.provider.broadcastTransaction(signedTx)
    ).wait();
    expect(receipt!.status).to.equal(1);
    journal.reward!.status = "confirmed";
    journal.reward!.blockNumber = String(receipt!.blockNumber);
    journal.reward!.blockHash = receipt!.blockHash;
    expect(parseRewardDeploymentJournal(journal).reward!.status).to.equal(
      "confirmed",
    );
    const deployed = await ethers.getContractAt(
      "RewardPayments",
      receipt!.contractAddress!,
    );
    expect(await deployed.token()).to.equal(await token.getAddress());
    expect(await deployed.owner()).to.equal(administrator.address);
  });

  it("preserves the exact already-deployed MJPY and DemoPayments creation bytecode", async () => {
    const expected: Record<string, string> = {
      MatsuriStablecoin:
        "0xbe022851384dd9a7adcb7c7765ea3801313b8e783d227f266ff5715251611c86",
      DemoPayments:
        "0x12dfcc901f485daa8b46bbb2d100a5bc96543b339fbc4501c7d8c9a1ff5b118a",
    };
    for (const [name, hash] of Object.entries(expected)) {
      const artifact = JSON.parse(
        await readFile(
          new URL(`../artifacts/src/${name}.sol/${name}.json`, import.meta.url),
          "utf8",
        ),
      );
      expect(keccak256(artifact.bytecode)).to.equal(hash);
    }
  });
});
