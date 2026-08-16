/**
 * scripts/deposit.js
 *
 * Deposit the entire token/ETH balance from the signer to Aave LendingPool.
 * - Reads ABI from abi/LendingPool.json in the repo.
 * - For ERC20: fetches token.balanceOf(signer) and approves+deposit full balance.
 * - For ETH: fetches signer ETH balance, keeps a gas reserve, and sends deposit with value.
 *
 * Environment variables (or GitHub Secrets when running in Actions):
 *   RPC_URL              - JSON-RPC endpoint (Infura/Alchemy)
 *   PRIVATE_KEY          - private key of signer (0x... format)
 *   LENDING_POOL_ADDRESS - address of LendingPool contract
 *   RESERVE_ADDRESS      - ERC20 token address OR the string "ETH" to use native ETH
 *   REFERRAL_CODE        - referral code (default 0)
 *   TARGET_ADDRESS       - public address to credit (default 0xc89b563D925438FeDA28Af05Ac2dBAc2314B8eB4)
 *   ETH_GAS_RESERVE      - amount in ETH to keep for gas (default 0.015)
 *
 * IMPORTANT SECURITY NOTES:
 * - Do NOT hardcode PRIVATE_KEY in the repository. Use GitHub Secrets or a local .env file.
 * - Ensure PRIVATE_KEY corresponds to the address you want to use as signer. If deposit ABI does NOT support onBehalfOf, the deposit will be credited to the signer address.
 */
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

async function main() {
  const RPC_URL = process.env.RPC_URL;
  const PRIVATE_KEY = process.env.PRIVATE_KEY;
  const LENDING_POOL_ADDRESS = process.env.LENDING_POOL_ADDRESS;
  const RESERVE_ADDRESS = process.env.RESERVE_ADDRESS;
  const REFERRAL_CODE = process.env.REFERRAL_CODE || '0';
  const TARGET_ADDRESS = process.env.TARGET_ADDRESS || '0xc89b563D925438FeDA28Af05Ac2dBAc2314B8eB4';
  const ETH_GAS_RESERVE = process.env.ETH_GAS_RESERVE || '0.015'; // ETH to reserve for gas when depositing ETH

  if (!RPC_URL || !PRIVATE_KEY || !LENDING_POOL_ADDRESS || !RESERVE_ADDRESS) {
    console.error('Missing required env vars. Set RPC_URL, PRIVATE_KEY, LENDING_POOL_ADDRESS, RESERVE_ADDRESS');
    process.exit(1);
  }

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log('Signer address:', wallet.address);
  console.log('TARGET_ADDRESS:', TARGET_ADDRESS);

  const abiPath = path.join(__dirname, '..', 'abi', 'LendingPool.json');
  if (!fs.existsSync(abiPath)) {
    console.error('abi/LendingPool.json not found in repo. Please ensure the ABI file exists at abi/LendingPool.json');
    process.exit(1);
  }
  const lendingPoolAbi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
  const lendingPool = new ethers.Contract(LENDING_POOL_ADDRESS, lendingPoolAbi, wallet);

  // ERC20 ABI with balanceOf
  const erc20Abi = [
    'function decimals() view returns (uint8)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address owner) view returns (uint256)'
  ];

  // Determine deposit function signature
  const depositEntry = lendingPoolAbi.find(e => e.name === 'deposit' && e.type === 'function');
  const depositInputsCount = depositEntry ? depositEntry.inputs.length : 0;
  console.log('deposit inputs count from ABI:', depositInputsCount);

  // If RESERVE_ADDRESS equals 'ETH' (case-insensitive) then treat as native ETH
  const isNativeETH = String(RESERVE_ADDRESS).toLowerCase() === 'eth' || RESERVE_ADDRESS === '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

  if (isNativeETH) {
    // Deposit native ETH: fetch balance, subtract gas reserve
    const balance = await provider.getBalance(wallet.address);
    const gasReserveWei = ethers.utils.parseEther(ETH_GAS_RESERVE);
    if (balance.lte(gasReserveWei)) {
      console.error('Insufficient ETH balance to cover gas reserve. Balance:', ethers.utils.formatEther(balance));
      process.exit(1);
    }
    const depositAmount = balance.sub(gasReserveWei);
    console.log('ETH balance:', ethers.utils.formatEther(balance), 'ETH');
    console.log('Reserving', ETH_GAS_RESERVE, 'ETH for gas. Will deposit:', ethers.utils.formatEther(depositAmount), 'ETH');

    // If deposit supports onBehalfOf (4 inputs), pass TARGET_ADDRESS, else will deposit credited to signer
    if (depositInputsCount === 4) {
      console.log('Calling deposit(reserve, amount, onBehalfOf, referral) with native ETH value');
      const tx = await lendingPool.deposit(ethers.constants.AddressZero, depositAmount, TARGET_ADDRESS, REFERRAL_CODE, { value: depositAmount });
      console.log('tx hash:', tx.hash);
      await tx.wait(1);
      console.log('Deposit confirmed');
    } else if (depositInputsCount === 3) {
      console.warn('deposit(reserve, amount, referral) does not accept onBehalfOf in this ABI; deposit will be credited to signer address');
      const tx = await lendingPool.deposit(ethers.constants.AddressZero, depositAmount, REFERRAL_CODE, { value: depositAmount });
      console.log('tx hash:', tx.hash);
      await tx.wait(1);
      console.log('Deposit confirmed');
    } else {
      console.error('Unknown deposit ABI signature. Cannot proceed for ETH deposit.');
      process.exit(1);
    }

  } else {
    // ERC20 flow
    const token = new ethers.Contract(RESERVE_ADDRESS, erc20Abi, wallet);
    const balance = await token.balanceOf(wallet.address);
    if (balance.isZero()) {
      console.error('Token balance is zero for', wallet.address);
      process.exit(1);
    }

    // Use full balance
    const amountToDeposit = balance;

    // Determine approve target: try core(), else lending pool
    let approveTarget = LENDING_POOL_ADDRESS;
    try {
      const coreAddr = await lendingPool.core();
      if (coreAddr && coreAddr !== ethers.constants.AddressZero) approveTarget = coreAddr;
    } catch (err) {
      console.warn('core() call failed; using LENDING_POOL_ADDRESS as approve target');
    }
    console.log('Approve target:', approveTarget);

    const currentAllowance = await token.allowance(wallet.address, approveTarget);
    console.log('Current allowance:', currentAllowance.toString());
    if (currentAllowance.lt(amountToDeposit)) {
      console.log('Sending approve for full balance...');
      const approveTx = await token.approve(approveTarget, amountToDeposit);
      console.log('approve tx hash:', approveTx.hash);
      await approveTx.wait(1);
      console.log('approve confirmed');
    } else {
      console.log('Allowance sufficient, skipping approve');
    }

    // Call deposit with full balance
    if (depositInputsCount === 4) {
      console.log('Calling deposit(reserve, amount, onBehalfOf, referral)');
      const tx = await lendingPool.deposit(RESERVE_ADDRESS, amountToDeposit, TARGET_ADDRESS, REFERRAL_CODE);
      console.log('deposit tx hash:', tx.hash);
      await tx.wait(1);
      console.log('Deposit confirmed');
    } else if (depositInputsCount === 3) {
      console.warn('deposit does not support onBehalfOf in this ABI. Deposit will be credited to signer address');
      const tx = await lendingPool.deposit(RESERVE_ADDRESS, amountToDeposit, REFERRAL_CODE);
      console.log('deposit tx hash:', tx.hash);
      await tx.wait(1);
      console.log('Deposit confirmed');
    } else {
      console.error('Unknown deposit ABI signature. Cannot proceed.');
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
