import { Connection, clusterApiUrl, Transaction } from "@solana/web3.js";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useWallet } from "@solana/wallet-adapter-react";
import { useState } from "react";
import "./index.css";

export default function App() {
  const wallet = useWallet();
  const [loadingGen, setLoadingGen] = useState(false);
  const [loadingUpload, setLoadingUpload] = useState(false);
  const [loadingMint, setLoadingMint] = useState(false);

  const [tokenId, setTokenId] = useState(null);
  const [image, setImage] = useState(null);
  const [prompt, setPrompt] = useState(null);
  const [attributes, setAttributes] = useState([]);

  const [imageIpfsUri, setImageIpfsUri] = useState(null);
  const [metadataIpfsUri, setMetadataIpfsUri] = useState(null);

  const [mintAddress, setMintAddress] = useState(null);
  const [error, setError] = useState(null);

  const API = "http://localhost:5175";

  async function generateImage() {
    setLoadingGen(true);
    setError(null);
    setMintAddress(null);

    setImageIpfsUri(null);
    setMetadataIpfsUri(null);

    try {
      const res = await fetch(`${API}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Generation failed");

      setTokenId(data.tokenId);
      setPrompt(data.prompt);
      setAttributes(data.attributes || []);
      setImage(data.imageBase64);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoadingGen(false);
    }
  }

  async function uploadToPinata() {
    if (!tokenId || !image) return;

    setLoadingUpload(true);
    setError(null);

    try {
      const res = await fetch(`${API}/api/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tokenId,
          imageBase64: image,
          prompt,
          attributes,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");

      setImageIpfsUri(data.imageIpfsUri);
      setMetadataIpfsUri(data.metadataUri);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoadingUpload(false);
    }
  }

  // ✅ REAL PHANTOM FLOW:
  // Server builds an unsigned tx (already partially signed by the mint keypair),
  // Phantom signs + sends, Phantom pays fees.
  async function mintNft() {
    if (!metadataIpfsUri) return;

    if (!wallet.connected || !wallet.publicKey || !wallet.signTransaction) {
      setError("Connect Phantom first.");
      return;
    }

    setLoadingMint(true);
    setError(null);

    try {
      // 1) Ask server to build mint transaction for THIS wallet
      const res = await fetch(`${API}/api/mintTx`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `OnyxAI #${tokenId}`,
          metadataUri: metadataIpfsUri,
          owner: wallet.publicKey.toBase58(),
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "MintTx build failed");

      const { txBase64, mint } = data;
      if (!txBase64 || !mint) throw new Error("Invalid tx from server");

      // 2) Decode transaction
      const tx = Transaction.from(Buffer.from(txBase64, "base64"));

      // 3) Phantom signs
      const signedTx = await wallet.signTransaction(tx);

      // 4) Send to devnet
      const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
      const sig = await connection.sendRawTransaction(signedTx.serialize(), {
        preflightCommitment: "confirmed",
      });

      // 5) Confirm
      await connection.confirmTransaction(sig, "confirmed");

      // 6) Update UI
      setMintAddress(mint);

      console.log("Tx:", `https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoadingMint(false);
    }
  }

  return (
    <div className="app">
      <div className="card">
        <h1>OnyxAI Generator & Minter (Devnet)</h1>

        <div style={{ marginBottom: 12 }}>
          <WalletMultiButton />
          <div style={{ marginTop: 8, opacity: 0.85 }}>
            Wallet: {wallet.connected ? "Connected ✅" : "Not connected"}
          </div>
        </div>

        <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
          <button onClick={generateImage} disabled={loadingGen}>
            {loadingGen ? "Generating..." : "Generate Image"}
          </button>

          <button
            onClick={uploadToPinata}
            disabled={loadingUpload || !image || !tokenId}
            style={{ backgroundColor: !image ? "#334155" : "#10b981" }}
          >
            {loadingUpload ? "Uploading..." : "Upload to Pinata"}
          </button>

          <button
            onClick={mintNft}
            disabled={loadingMint || !metadataIpfsUri || !wallet.connected}
            style={{ backgroundColor: !metadataIpfsUri ? "#334155" : "#f59e0b" }}
          >
            {loadingMint ? "Minting..." : "Mint NFT"}
          </button>
        </div>

        {error && <p style={{ color: "#ef4444" }}>{error}</p>}

        {tokenId && (
          <p>
            <strong>Token ID:</strong> {tokenId}
          </p>
        )}

        {prompt && (
          <p>
            <strong>Prompt:</strong> {prompt}
          </p>
        )}

        {image && (
          <div className="preview">
            <img src={image} alt="Generated" />
          </div>
        )}

        {(imageIpfsUri || metadataIpfsUri) && (
          <div style={{ marginTop: 16, lineHeight: 1.6 }}>
            {imageIpfsUri && (
              <p>
                <strong>Image IPFS:</strong> {imageIpfsUri}
              </p>
            )}
            {metadataIpfsUri && (
              <p>
                <strong>Metadata IPFS:</strong> {metadataIpfsUri}
              </p>
            )}
          </div>
        )}

        {mintAddress && (
          <div style={{ marginTop: 16 }}>
            <p>
              <strong>Mint Address:</strong> {mintAddress}
            </p>
            <p>
              Explorer:{" "}
              <a
                href={`https://explorer.solana.com/address/${mintAddress}?cluster=devnet`}
                target="_blank"
                rel="noreferrer"
                style={{ color: "#60a5fa" }}
              >
                View on Solana Explorer
              </a>
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

