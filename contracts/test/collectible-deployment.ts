import { expect } from "chai";
import { network } from "hardhat";
import { Transaction, Wallet, getCreateAddress, keccak256 } from "ethers";
import {
  parseCollectibleDeploymentJournal,
  type CollectibleDeploymentJournal,
} from "../scripts/deploy-collectibles-multibaas.js";
const { ethers } = await network.create({ override: { chainId: 11155111 } });

describe("Collectible deployment durable journal recovery", () => {
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
    const factory = await ethers.getContractFactory(
      "CollectibleRewards",
      signer,
    );
    const unsigned = await signer.populateTransaction(
      await factory.getDeployTransaction(
        await token.getAddress(),
        administrator.address,
        "https://example.org/nft-art/pinned/",
      ),
    );
    const signedTx = await signer.signTransaction(unsigned);
    const tx = Transaction.from(signedTx);
    const journal: CollectibleDeploymentJournal = {
      format: "suica-collectible-deployment-v1",
      chainId: "11155111",
      multibaasUrl: "https://multibaas.example",
      keyId: "local-evm-signer",
      deployer: signer.address.toLowerCase(),
      administrator: administrator.address.toLowerCase(),
      tokenAddress: (await token.getAddress()).toLowerCase(),
      artworkBaseURI: "https://example.org/nft-art/pinned/",
      label: "collectiblerewards",
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
      parseCollectibleDeploymentJournal(journal).reward!.transactionHash,
    ).to.equal(tx.hash);
    for (const changed of [
      { transactionHash: ethers.ZeroHash },
      { calldataHash: ethers.ZeroHash },
      { nonce: String(tx.nonce + 1) },
      { address: administrator.address },
      { status: "confirmed" },
    ]) {
      expect(() =>
        parseCollectibleDeploymentJournal({
          ...journal,
          reward: { ...journal.reward, ...changed },
        }),
      ).to.throw();
    }
    expect(() =>
      parseCollectibleDeploymentJournal({ ...journal, chainId: "6497" }),
    ).to.throw();
    expect(() =>
      parseCollectibleDeploymentJournal({
        ...journal,
        tokenAddress: ethers.ZeroAddress,
      }),
    ).to.throw();
    expect(() =>
      parseCollectibleDeploymentJournal({
        ...journal,
        artworkBaseURI: "http://unsafe/",
      }),
    ).to.throw();
    const receipt = await (
      await ethers.provider.broadcastTransaction(signedTx)
    ).wait();
    expect(receipt!.status).to.equal(1);
    journal.reward!.status = "confirmed";
    journal.reward!.blockNumber = String(receipt!.blockNumber);
    journal.reward!.blockHash = receipt!.blockHash;
    expect(parseCollectibleDeploymentJournal(journal).reward!.status).to.equal(
      "confirmed",
    );
    const deployed = await ethers.getContractAt(
      "CollectibleRewards",
      receipt!.contractAddress!,
    );
    expect(await deployed.token()).to.equal(await token.getAddress());
    expect(await deployed.owner()).to.equal(administrator.address);
    expect(await deployed.artworkBaseURI()).to.equal(journal.artworkBaseURI);
  });
});
