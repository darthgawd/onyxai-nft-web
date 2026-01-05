import "dotenv/config";
import fs from "fs-extra";
import path from "path";
import {
  Connection,
  clusterApiUrl,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

async function main() {
  const to = process.argv[2];
  const amountSol = Number(process.argv[3] || "1");

  if (!to) {
    console.error("Usage: node fundPhantom.js <PHANTOM_ADDRESS> [AMOUNT_SOL]");
    process.exit(1);
  }

  const toPk = new PublicKey(to);

  const KEYPAIR_PATH = path.join(process.env.HOME, ".config/solana/id.json");
  const secret = await fs.readJson(KEYPAIR_PATH);
  const fromKp = Keypair.fromSecretKey(Uint8Array.from(secret));

  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

  const lamports = Math.floor(amountSol * LAMPORTS_PER_SOL);

  // Ensure sender has funds on devnet (airdrop if needed)
  const fromBal = await connection.getBalance(fromKp.publicKey);
  if (fromBal < lamports + 5000) {
    console.log("Sender low on devnet SOL. Requesting airdrop 2 SOL...");
    const sig = await connection.requestAirdrop(fromKp.publicKey, 2 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }

  console.log("From:", fromKp.publicKey.toBase58());
  console.log("To  :", toPk.toBase58());
  console.log("Amount (SOL):", amountSol);

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKp.publicKey,
      toPubkey: toPk,
      lamports,
    })
  );

  const sig = await sendAndConfirmTransaction(connection, tx, [fromKp], {
    commitment: "confirmed",
  });

  console.log("✅ Transfer confirmed:", sig);
  console.log("Explorer:", `https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  const toBal = await connection.getBalance(toPk);
  console.log("Recipient balance (SOL):", (toBal / LAMPORTS_PER_SOL).toFixed(4));
}

main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});

