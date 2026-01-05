import "dotenv/config";
import express from "express";
import cors from "cors";
import axios from "axios";
import crypto from "crypto";
import FormData from "form-data";
import fs from "fs-extra";
import path from "path";
import {
  Connection,
  clusterApiUrl,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  MINT_SIZE,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
} from "@solana/spl-token";

import { Metaplex, keypairIdentity } from "@metaplex-foundation/js";

// ✅ Umi + mpl-token-metadata (stable ESM API)
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { publicKey as umiPublicKey } from "@metaplex-foundation/umi";
import {
  findMetadataPda,
  findMasterEditionPda,
  createMetadataAccountV3,
  createMasterEditionV3,
} from "@metaplex-foundation/mpl-token-metadata";

const app = express();
app.use(cors());
app.use(express.json({ limit: "35mb" }));

const STABILITY_API_KEY = process.env.STABILITY_API_KEY;
const PINATA_JWT = process.env.PINATA_JWT;

if (!STABILITY_API_KEY) throw new Error("Missing STABILITY_API_KEY in .env");
if (!PINATA_JWT) throw new Error("Missing PINATA_JWT in .env");

const STABILITY_URL = "https://api.stability.ai/v2beta/stable-image/generate/sd3";

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randomSeed() {
  return parseInt(crypto.randomBytes(4).toString("hex"), 16);
}
function buildPrompt() {
  const subjects = [
    "afrofuturist astronaut",
    "cybernetic lion spirit",
    "ancient masked oracle",
    "neon desert monument",
    "floating crystal entity",
  ];
  const styles = [
    "clean vector illustration",
    "high contrast poster art",
    "minimalist graphic style",
    "sci-fi concept art",
  ];
  const moods = ["mysterious", "uplifting", "intense", "calm"];
  const palette = [
    "purple and electric blue",
    "teal and gold",
    "sunset orange and violet",
    "black and white with one red accent",
  ];

  const subject = pick(subjects);
  const style = pick(styles);
  const mood = pick(moods);
  const pal = pick(palette);

  return {
    prompt: `${subject}, ${style}, ${mood}, ${pal}, centered composition, no text, no watermark`,
    attributes: [
      { trait_type: "Subject", value: subject },
      { trait_type: "Style", value: style },
      { trait_type: "Mood", value: mood },
      { trait_type: "Palette", value: pal },
    ],
  };
}

async function generateImage(prompt, seedValue) {
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("seed", String(seedValue));
  form.append("output_format", "png");
  form.append("width", "1024");
  form.append("height", "1024");

  const res = await axios.post(STABILITY_URL, form, {
    headers: {
      Authorization: `Bearer ${STABILITY_API_KEY}`,
      ...form.getHeaders(),
      Accept: "image/*",
    },
    responseType: "arraybuffer",
    validateStatus: () => true,
  });

  const contentType = (res.headers["content-type"] || "").toLowerCase();

  if (res.status === 402) {
    const text = Buffer.from(res.data).toString("utf8");
    throw new Error(`402 Payment Required. ${text}`);
  }
  if (contentType.includes("application/json")) {
    const text = Buffer.from(res.data).toString("utf8");
    throw new Error(`API returned JSON (${res.status}): ${text}`);
  }
  if (!contentType.startsWith("image/")) {
    const text = Buffer.from(res.data).toString("utf8");
    throw new Error(
      `Unexpected content-type ${contentType} (${res.status}): ${text}`
    );
  }

  return Buffer.from(res.data);
}

async function pinFileFromBuffer(buffer, filename, name, keyvalues = {}) {
  const data = new FormData();
  data.append("file", buffer, { filename, contentType: "image/png" });
  data.append("pinataMetadata", JSON.stringify({ name, keyvalues }));

  const res = await axios.post(
    "https://api.pinata.cloud/pinning/pinFileToIPFS",
    data,
    {
      maxBodyLength: Infinity,
      headers: {
        Authorization: `Bearer ${PINATA_JWT}`,
        ...data.getHeaders(),
      },
    }
  );

  return res.data.IpfsHash;
}

async function pinJSON(json, name, keyvalues = {}) {
  const payload = {
    pinataMetadata: { name, keyvalues },
    pinataContent: json,
  };

  const res = await axios.post(
    "https://api.pinata.cloud/pinning/pinJSONToIPFS",
    payload,
    {
      headers: {
        Authorization: `Bearer ${PINATA_JWT}`,
        "Content-Type": "application/json",
      },
    }
  );

  return res.data.IpfsHash;
}

function ipfsToHttps(uri) {
  if (!uri) return uri;
  if (uri.startsWith("ipfs://"))
    return uri.replace("ipfs://", "https://gateway.pinata.cloud/ipfs/");
  return uri;
}

// ✅ Build a transaction for Phantom to sign/pay fees
app.post("/api/mintTx", async (req, res) => {
  try {
    const { name, metadataUri, owner } = req.body || {};
    if (!metadataUri) return res.status(400).json({ error: "metadataUri required" });
    if (!owner) return res.status(400).json({ error: "owner required" });

    const payer = new PublicKey(owner);     // Phantom wallet
    const mint = Keypair.generate();        // new mint account (server will partially sign)

    const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
    const uri = ipfsToHttps(metadataUri);

    const ata = await getAssociatedTokenAddress(mint.publicKey, payer);

    // rent for mint account
    const lamportsForMint = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);

    const tx = new Transaction();

    // 1) Create mint account
    tx.add(
      SystemProgram.createAccount({
        fromPubkey: payer,
        newAccountPubkey: mint.publicKey,
        lamports: lamportsForMint,
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      })
    );

    // 2) Init mint
    tx.add(createInitializeMintInstruction(mint.publicKey, 0, payer, payer));

    // 3) Create ATA
    tx.add(createAssociatedTokenAccountInstruction(payer, ata, payer, mint.publicKey));

    // 4) Mint 1 token
    tx.add(createMintToInstruction(mint.publicKey, ata, payer, 1));

    // --- Umi builders for Token Metadata (NO CJS/ESM issues) ---
    const umi = createUmi(clusterApiUrl("devnet"));

    const umiMint = umiPublicKey(mint.publicKey.toBase58());
    const umiPayer = umiPublicKey(payer.toBase58());

    const metadataPda = findMetadataPda(umi, { mint: umiMint })[0];
    const masterEditionPda = findMasterEditionPda(umi, { mint: umiMint })[0];

    const mdIx = createMetadataAccountV3(umi, {
      metadata: metadataPda,
      mint: umiMint,
      mintAuthority: umiPayer,
      payer: umiPayer,
      updateAuthority: umiPayer,
      data: {
        name: name || "OnyxAI NFT",
        symbol: "ONYXAI",
        uri,
        sellerFeeBasisPoints: 500,
        creators: null,
        collection: null,
        uses: null,
      },
      isMutable: true,
      collectionDetails: null,
    }).getInstructions()[0];

    const meIx = createMasterEditionV3(umi, {
      edition: masterEditionPda,
      metadata: metadataPda,
      mint: umiMint,
      mintAuthority: umiPayer,
      payer: umiPayer,
      updateAuthority: umiPayer,
      maxSupply: 0,
    }).getInstructions()[0];

    // Convert Umi instruction -> web3 TransactionInstruction
    tx.add({
      keys: mdIx.keys.map((k) => ({
        pubkey: new PublicKey(k.pubkey),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      programId: new PublicKey(mdIx.programId),
      data: Buffer.from(mdIx.data),
    });

    tx.add({
      keys: meIx.keys.map((k) => ({
        pubkey: new PublicKey(k.pubkey),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      programId: new PublicKey(meIx.programId),
      data: Buffer.from(meIx.data),
    });

    // recent blockhash + fee payer
    const { blockhash, lastValidBlockHeight } =
      await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = payer;

    // server partially signs mint (Phantom signs as payer/mintAuthority)
    tx.partialSign(mint);

    const txBase64 = tx
      .serialize({ requireAllSignatures: false })
      .toString("base64");

    res.json({
      txBase64,
      mint: mint.publicKey.toBase58(),
      lastValidBlockHeight,
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ✅ Old server-keypair mint endpoint (optional fallback)
app.post("/api/mint", async (req, res) => {
  try {
    const { name, metadataUri, owner } = req.body || {};
    if (!metadataUri) return res.status(400).json({ error: "metadataUri required" });
    if (!owner) return res.status(400).json({ error: "owner required" });

    const KEYPAIR_PATH = path.join(process.env.HOME, ".config/solana/id.json");
    const secret = await fs.readJson(KEYPAIR_PATH);
    const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));

    const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
    const metaplex = Metaplex.make(connection).use(keypairIdentity(keypair));

    const uri = ipfsToHttps(metadataUri);
    const ownerPk = new PublicKey(owner);

    const { nft } = await metaplex.nfts().create({
      uri,
      name: name || "OnyxAI NFT",
      sellerFeeBasisPoints: 500,
      tokenOwner: ownerPk,
    });

    res.json({ mint: nft.address.toBase58(), uri, owner });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// generate image
app.post("/api/generate", async (req, res) => {
  try {
    const tokenId = Date.now();
    const useAuto = req.body?.useAuto !== false;

    const built = useAuto ? buildPrompt() : null;
    const prompt = useAuto ? built.prompt : req.body.prompt;

    if (!prompt) return res.status(400).json({ error: "prompt required" });

    const seed = randomSeed();
    const img = await generateImage(prompt, seed);

    const imageBase64 = `data:image/png;base64,${img.toString("base64")}`;

    res.json({
      tokenId,
      prompt,
      seed,
      attributes: built?.attributes || req.body.attributes || [],
      imageBase64,
      imageBase64Preview: imageBase64.slice(0, 60) + "...",
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// upload image + metadata
app.post("/api/upload", async (req, res) => {
  try {
    const { tokenId, imageBase64, prompt, attributes } = req.body;
    if (!tokenId || !imageBase64)
      return res.status(400).json({ error: "tokenId and imageBase64 required" });

    const base64Data = imageBase64.split(",")[1];
    const buffer = Buffer.from(base64Data, "base64");

    const imageHash = await pinFileFromBuffer(
      buffer,
      `${tokenId}.png`,
      `OnyxAI-Image-${tokenId}`,
      {
        project: "onyxai-nft",
        id: String(tokenId),
        kind: "image",
      }
    );
    const imageIpfsUri = `ipfs://${imageHash}`;

    const metadata = {
      name: `OnyxAI #${tokenId}`,
      description:
        "AI-generated NFT collection minted on Solana. Generated and uploaded via JavaScript automation.",
      image: ipfsToHttps(imageIpfsUri),
      attributes: [
        ...(attributes || []),
        ...(prompt ? [{ trait_type: "Prompt", value: prompt }] : []),
        { trait_type: "Generation ID", value: String(tokenId) },
        { trait_type: "Network", value: "Solana Devnet" },
      ],
    };

    const metaHash = await pinJSON(metadata, `OnyxAI-Metadata-${tokenId}`, {
      project: "onyxai-nft",
      id: String(tokenId),
      kind: "metadata",
    });

    const metadataUri = `ipfs://${metaHash}`;

    res.json({
      tokenId,
      imageIpfsUri,
      imageGatewayUrl: ipfsToHttps(imageIpfsUri),
      metadataUri,
      metadataGatewayUrl: ipfsToHttps(metadataUri),
    });
  } catch (e) {
    res.status(500).json({ error: e?.response?.data || e?.message || String(e) });
  }
});

app.listen(5175, () => console.log("API running http://localhost:5175"));

