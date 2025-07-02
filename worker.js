require('dotenv').config();
const { Worker } = require('bullmq');
const { ethers } = require('ethers');
const { PrismaClient } = require('@prisma/client');
const alertingService = require('./services/alerting_service');

const prisma = new PrismaClient();

// Standard ERC20 ABI for the 'transfer' function and 'decimals'
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
];

const connection = {
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: process.env.REDIS_PORT || 6379,
};

const multiSigWorker = new Worker(
  'withdrawal-processing',
  async (job) => {
    const { dbId } = job.data;
    console.log(`[WORKER] Processing job ${job.id} (Attempt #${job.attemptsMade + 1}) for DB request ${dbId}`);

    const request = await prisma.withdrawalRequest.findUnique({ where: { id: dbId } });

    // Skip processing if the request has been successfully completed or cancelled.
    if (!request || ['COMPLETED', 'CANCELLED'].includes(request.status)) {
      console.log(`[WORKER] Skipping job ${job.id}, request already in a final state: ${request?.status}.`);
      return;
    }

    // --- Blockchain Connection Setup ---
    const network = process.env.ETHEREUM_NETWORK || 'sepolia';
    const rpcUrl = network === 'mainnet' ? process.env.MAINNET_RPC_URL : process.env.SEPOLIA_RPC_URL;
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const serviceWallet = new ethers.Wallet(process.env.SERVICE_WALLET_PRIVATE_KEY, provider);

    // The try...catch block now re-throws errors to let BullMQ handle retries.
    // The final 'failed' state is handled by the 'failed' event listener.
    try {
      // Set status to PROCESSING only if it's the first attempt.
      if (job.attemptsMade === 0) {
        await prisma.withdrawalRequest.update({
          where: { id: dbId },
          data: {
            status: 'PROCESSING',
            errorMessage: null, // Clear previous errors on a new run
            history: { create: { status: 'PROCESSING' } },
          },
        });
      }

      // --- ERC20 Token Transfer Logic ---
      const tokenContract = new ethers.Contract(request.tokenContractAddress, ERC20_ABI, serviceWallet);

      // Dynamically fetch token decimals for accuracy
      const decimals = await tokenContract.decimals();
      const tokenAmount = ethers.parseUnits(request.amount, decimals);

      // --- Dynamic Gas Price Management (EIP-1559) ---
      const feeData = await provider.getFeeData();
      console.log(`[WORKER] Current network fee data: maxFeePerGas=${ethers.formatUnits(feeData.maxFeePerGas, "gwei")} gwei, maxPriorityFeePerGas=${ethers.formatUnits(feeData.maxPriorityFeePerGas, "gwei")} gwei`);

      const txOverrides = {
        maxFeePerGas: feeData.maxFeePerGas,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      };

      console.log(`[WORKER] Broadcasting ERC20 transfer for request ${request.requestId} with dynamic gas.`);
      const txResponse = await tokenContract.transfer(
        request.destinationAddress,
        tokenAmount,
        txOverrides
      );

      await prisma.withdrawalRequest.update({
        where: { id: dbId },
        data: {
          status: 'BROADCASTED',
          txHash: txResponse.hash,
          history: { create: { status: 'BROADCASTED' } },
        },
      });
      console.log(`[WORKER] Transaction broadcasted for ${request.requestId}. TxHash: ${txResponse.hash}`);

      await txResponse.wait(1); // Wait for 1 confirmation

      await prisma.withdrawalRequest.update({
        where: { id: dbId },
        data: { status: 'COMPLETED', history: { create: { status: 'COMPLETED' } } },
      });
      console.log(`[WORKER] Transaction confirmed for ${request.requestId}.`);
    } catch (error) {
      console.error(`[WORKER-ERROR] Attempt #${job.attemptsMade + 1} failed for job ${job.id} (${request.requestId}):`, error.message);
      // Re-throw the error to trigger BullMQ's retry mechanism.
      throw error;
    }
  },
  {
    connection,
    // --- Retry Logic Configuration ---
    attempts: 5, // Try a job up to 5 times
    backoff: {
      type: 'exponential', // Use exponential backoff
      delay: 10000, // Start with a 10-second delay (10s, 20s, 40s, 80s)
    },
  }
);

// --- Worker for the Raw Transaction Relay Model ---

const rawTxBroadcastWorker = new Worker(
  'raw-tx-broadcasting',
  async (job) => {
    const { dbId } = job.data;
    console.log(`[RAW-TX-WORKER] Processing job ${job.id} for DB request ${dbId}`);

    const request = await prisma.rawTransactionBroadcast.findUnique({ where: { id: dbId } });

    if (!request || request.status !== 'PENDING') {
      console.log(`[RAW-TX-WORKER] Skipping job ${job.id}, request not found or not in pending state.`);
      return;
    }

    const network = process.env.ETHEREUM_NETWORK || 'sepolia';
    const rpcUrl = network === 'mainnet' ? process.env.MAINNET_RPC_URL : process.env.SEPOLIA_RPC_URL;
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    try {
      console.log(`[RAW-TX-WORKER] Broadcasting raw transaction for request ${request.id}`);
      const txResponse = await provider.broadcastTransaction(request.rawTx);

      await prisma.rawTransactionBroadcast.update({
        where: { id: dbId },
        data: { status: 'BROADCASTED', txHash: txResponse.hash },
      });
      console.log(`[RAW-TX-WORKER] Transaction broadcasted for ${request.id}. TxHash: ${txResponse.hash}`);

      await txResponse.wait(1);

      await prisma.rawTransactionBroadcast.update({
        where: { id: dbId },
        data: { status: 'CONFIRMED' },
      });
      console.log(`[RAW-TX-WORKER] Transaction confirmed for ${request.id}.`);
    } catch (error) {
      console.error(`[RAW-TX-WORKER-ERROR] Attempt #${job.attemptsMade + 1} failed for job ${job.id} (${request.id}):`, error.message);
      throw error;
    }
  },
  {
    connection,
    attempts: 3, // Fewer retries for raw tx as failure is more likely due to invalid user input
    backoff: { type: 'exponential', delay: 5000 },
  }
);

function setupEventListeners() {
  multiSigWorker.on('completed', (job) => {
    console.log(`[WORKER-SUCCESS] Multi-sig job ${job.id} has completed!`);
  });

  multiSigWorker.on('failed', async (job, err) => {
    console.error(`[WORKER-FATAL] Multi-sig job ${job.id} has failed after ${job.attemptsMade + 1} attempts with error: ${err.message}`);
    const { dbId } = job.data;
    await prisma.withdrawalRequest.update({
      where: { id: dbId },
      data: { status: 'FAILED', errorMessage: err.message, history: { create: { status: 'FAILED' } } },
    });
    await alertingService.sendAlert('Multi-Sig Withdrawal Job Failed', {
      jobId: job.id, databaseId: dbId, attempts: job.attemptsMade + 1, error: err.message,
    });
  });

  rawTxBroadcastWorker.on('completed', (job) => {
    console.log(`[RAW-TX-WORKER-SUCCESS] Raw TX job ${job.id} has completed!`);
  });

  rawTxBroadcastWorker.on('failed', async (job, err) => {
    console.error(`[RAW-TX-WORKER-FATAL] Raw TX job ${job.id} has failed after ${job.attemptsMade + 1} attempts with error: ${err.message}`);
    const { dbId } = job.data;
    await prisma.rawTransactionBroadcast.update({
      where: { id: dbId },
      data: { status: 'FAILED', errorMessage: err.message },
    });
    await alertingService.sendAlert('Raw Transaction Broadcast Job Failed', {
      jobId: job.id, databaseId: dbId, attempts: job.attemptsMade + 1, error: err.message,
    });
  });

  console.log('All workers started and listening for jobs...');
}

async function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  await multiSigWorker.close();
  await rawTxBroadcastWorker.close();
  await prisma.$disconnect();
  console.log('All connections closed. Exiting.');
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

setupEventListeners();