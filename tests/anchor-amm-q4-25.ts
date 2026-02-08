import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { AnchorAmmQ425 } from "../target/types/anchor_amm_q4_25";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";

describe("anchor-amm-q4-25", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const program = anchor.workspace.anchorAmmQ425 as Program<AnchorAmmQ425>;
  const wallet = provider.wallet;
  const connection = provider.connection;

  const seed = new anchor.BN(1);
  const fee = 100; // 1%

  let mintX: anchor.web3.PublicKey;
  let mintY: anchor.web3.PublicKey;
  let configPda: anchor.web3.PublicKey;
  let mintLpPda: anchor.web3.PublicKey;
  let vaultX: anchor.web3.PublicKey;
  let vaultY: anchor.web3.PublicKey;
  let userX: anchor.web3.PublicKey;
  let userY: anchor.web3.PublicKey;
  let userLp: anchor.web3.PublicKey;

  before(async () => {
    mintX = await createMint(
      connection,
      wallet.payer,
      wallet.publicKey,
      null,
      6,
    );
    mintY = await createMint(
      connection,
      wallet.payer,
      wallet.publicKey,
      null,
      6,
    );

    [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config"), seed.toArrayLike(Buffer, "le", 8)],
      program.programId,
    );
    [mintLpPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("lp"), configPda.toBuffer()],
      program.programId,
    );

    vaultX = await getAssociatedTokenAddress(mintX, configPda, true);
    vaultY = await getAssociatedTokenAddress(mintY, configPda, true);

    userX = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        wallet.payer,
        mintX,
        wallet.publicKey,
      )
    ).address;
    userY = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        wallet.payer,
        mintY,
        wallet.publicKey,
      )
    ).address;
  });

  it("initializes the pool", async () => {
    await program.methods
      .initialize(seed, fee, null)
      .accounts({
        initializer: wallet.publicKey,
        mintX,
        mintY,
        config: configPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .rpc();

    userLp = (
      await getOrCreateAssociatedTokenAccount(
        connection,
        wallet.payer,
        mintLpPda,
        wallet.publicKey,
      )
    ).address;

    const config = await program.account.config.fetch(configPda);
    assert.equal(config.seed.toString(), seed.toString());
    assert.equal(config.mintX.toBase58(), mintX.toBase58());
    assert.equal(config.mintY.toBase58(), mintY.toBase58());
    assert.equal(config.fee, fee);
    assert.equal(config.locked, false);
  });

  it("deposits initial liquidity", async () => {
    const amount = new anchor.BN(1_000_000);
    const maxX = new anchor.BN(1_000_000);
    const maxY = new anchor.BN(1_000_000);

    await mintTo(
      connection,
      wallet.payer,
      mintX,
      userX,
      wallet.payer,
      1_000_000,
    );
    await mintTo(
      connection,
      wallet.payer,
      mintY,
      userY,
      wallet.payer,
      1_000_000,
    );

    await program.methods
      .deposit(amount, maxX, maxY)
      .accounts({
        user: wallet.publicKey,
        config: configPda,
        userX,
        userY,
        userLp,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    const vaultXAccount = await getAccount(connection, vaultX);
    const vaultYAccount = await getAccount(connection, vaultY);
    const userLpAccount = await getAccount(connection, userLp);

    assert.equal(Number(vaultXAccount.amount), 1_000_000);
    assert.equal(Number(vaultYAccount.amount), 1_000_000);
    assert.equal(Number(userLpAccount.amount), 1_000_000);
  });

  it("swaps token X for token Y", async () => {
    const amountIn = new anchor.BN(100_000);
    const minOut = new anchor.BN(1);

    await mintTo(connection, wallet.payer, mintX, userX, wallet.payer, 100_000);

    const beforeUserX = await getAccount(connection, userX);
    const beforeUserY = await getAccount(connection, userY);
    const beforeVaultX = await getAccount(connection, vaultX);
    const beforeVaultY = await getAccount(connection, vaultY);

    await program.methods
      .swap(true, amountIn, minOut)
      .accounts({
        user: wallet.publicKey,
        config: configPda,
        mintX,
        mintY,
        mintLp: mintLpPda,
        vaultX,
        vaultY,
        userX,
        userY,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    const afterUserX = await getAccount(connection, userX);
    const afterUserY = await getAccount(connection, userY);
    const afterVaultX = await getAccount(connection, vaultX);
    const afterVaultY = await getAccount(connection, vaultY);

    assert.equal(
      Number(beforeUserX.amount) - Number(afterUserX.amount),
      100_000,
    );
    assert.isAbove(Number(afterUserY.amount), Number(beforeUserY.amount));
    assert.isAbove(Number(afterVaultX.amount), Number(beforeVaultX.amount));
    assert.isBelow(Number(afterVaultY.amount), Number(beforeVaultY.amount));
  });

  it("withdraws liquidity", async () => {
    const withdrawAmount = new anchor.BN(200_000);

    const beforeUserX = await getAccount(connection, userX);
    const beforeUserY = await getAccount(connection, userY);
    const beforeUserLp = await getAccount(connection, userLp);
    const beforeVaultX = await getAccount(connection, vaultX);
    const beforeVaultY = await getAccount(connection, vaultY);

    await program.methods
      .withdraw(withdrawAmount, new anchor.BN(0), new anchor.BN(0))
      .accounts({
        user: wallet.publicKey,
        config: configPda,
        userX,
        userY,
        userLp,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    const afterUserX = await getAccount(connection, userX);
    const afterUserY = await getAccount(connection, userY);
    const afterUserLp = await getAccount(connection, userLp);
    const afterVaultX = await getAccount(connection, vaultX);
    const afterVaultY = await getAccount(connection, vaultY);

    assert.equal(
      Number(beforeUserLp.amount) - Number(afterUserLp.amount),
      200_000,
    );
    assert.isAbove(Number(afterUserX.amount), Number(beforeUserX.amount));
    assert.isAbove(Number(afterUserY.amount), Number(beforeUserY.amount));
    assert.isBelow(Number(afterVaultX.amount), Number(beforeVaultX.amount));
    assert.isBelow(Number(afterVaultY.amount), Number(beforeVaultY.amount));
  });
});
