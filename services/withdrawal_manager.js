require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { Queue } = require('bullmq');

/**
 * Withdrawal Manager Service
 *
 * This service is the core of the withdrawal activation logic. It handles:
 * - Validating and persisting withdrawal requests to the database.
 * - Enqueuing requests for processing by a separate worker.
 */

class WithdrawalManager {
  constructor() {
    // --- Blockchain Connection Setup ---
    const network = process.env.ETHEREUM_NETWORK || 'sepolia'; // Default to sepolia for safety
    const rpcUrl =
      network === 'mainnet' ?
      process.env.MAINNET_RPC_URL :
      process.env.SEPOLIA_RPC_URL;

    if (!rpcUrl) {
      throw new Error(
        `RPC URL for network '${network}' is not defined in environment variables.`
      );
    }
    this.prisma = new PrismaClient();
    this.withdrawalQueue = new Queue('withdrawal-processing', {
      connection: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: process.env.REDIS_PORT || 6379,
      },
    });
    this.rawTxBroadcastQueue = new Queue('raw-tx-broadcasting', {
      connection: {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: process.env.REDIS_PORT || 6379,
      },
    });
  }

  /**
   * Processes a new multi-sig withdrawal request from the bank.
   * @param {object} requestData - The validated request data from the API.
   */
  async processNewRequest(requestData) {
    const existingRequest = await this.prisma.withdrawalRequest.findUnique({
      where: { requestId: requestData.request_id },
    });

    if (existingRequest) {
      throw new Error(
        'Duplicate request_id. This request has already been submitted.'
      );
    }

    const newRequest = await this.prisma.withdrawalRequest.create({
      data: {
        requestId: requestData.request_id,
        treasuryContractAddress: requestData.treasury_contract_address,
        destinationAddress: requestData.destination_address,
        tokenContractAddress: requestData.token_contract_address,
        amount: requestData.amount,
        partiallySignedTx: requestData.partially_signed_tx,
        history: { create: { status: 'PENDING_SIGNATURE' } },
      },
    });

    // Add a job to the queue for the worker to process
    await this.withdrawalQueue.add('process-withdrawal', { dbId: newRequest.id });
    console.log(`[INFO] New request ${newRequest.requestId} saved and enqueued for processing.`);

    return { requestId: requestData.request_id, receivedAt: new Date().toISOString() };
  }

  /**
   * Cancels a pending withdrawal request.
   * @param {string} requestId - The unique ID of the request to cancel.
   */
  async cancelRequest(requestId) {
    const request = await this.prisma.withdrawalRequest.findUnique({
      where: { requestId },
    });

    if (!request) {
      throw new Error('Request not found.');
    }

    if (request.status !== 'PENDING_SIGNATURE') {
      throw new Error(
        `Cannot cancel request. Status is already '${request.status}'.`
      );
    }

    const updatedRequest = await this.prisma.withdrawalRequest.update({
      where: { requestId },
      data: { status: 'CANCELLED', history: { create: { status: 'CANCELLED' } } },
    });

    console.log(`[INFO] Request cancelled by client: ${requestId}`);
    return { requestId: updatedRequest.requestId, status: updatedRequest.status };
  }

  /**
   * Retrieves the current status and details of a withdrawal request.
   * @param {string} requestId - The unique ID of the request to retrieve.
   */
  async getRequestStatus(requestId) {
    const request = await this.prisma.withdrawalRequest.findUnique({
      where: { requestId },
      include: { history: true }, // Include the status history
    });

    if (!request) {
      throw new Error('Request not found.');
    }

    return request;
  }

  /**
   * Retrieves all requests for the dashboard with pagination.
   * @param {object} options - Pagination options.
   * @param {number} options.page - The current page number.
   * @param {number} options.pageSize - The number of items per page.
   */
  async getAllRequests({ page = 1, pageSize = 10 }) {
    const skip = (page - 1) * pageSize;
    const take = pageSize;

    const [requests, total] = await this.prisma.$transaction([
      this.prisma.withdrawalRequest.findMany({
        skip,
        take,
        orderBy: {
          createdAt: 'desc',
        },
      }),
      this.prisma.withdrawalRequest.count(),
    ]);

    return {
      data: requests,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  }

  /**
   * Processes a new raw transaction broadcast request.
   * @param {string} rawTx - The signed raw transaction hex string.
   * @param {string} [clientId] - The ID of the client making the request.
   */
  async processRawTransactionBroadcast(rawTx, clientId) {
    const newBroadcast = await this.prisma.rawTransactionBroadcast.create({
      data: {
        rawTx,
        clientId, // Useful for logging and tenancy
      },
    });

    // Add a job to the new queue for the broadcast worker
    await this.rawTxBroadcastQueue.add('broadcast-raw-tx', { dbId: newBroadcast.id });
    console.log(`[INFO] New raw transaction ${newBroadcast.id} received and enqueued for broadcasting.`);

    return { broadcastId: newBroadcast.id, status: 'PENDING' };
  }

  /**
   * Checks the health of the service's dependencies (Database, Queue).
   * @returns {Promise<{healthStatus: object, isHealthy: boolean}>}
   */
  async checkHealth() {
    const health = {
      database: { status: 'OK', message: 'Connected' },
      queue: { status: 'OK', message: 'Connected' },
      overallStatus: 'OK',
      timestamp: new Date().toISOString(),
    };
    let isHealthy = true;

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (e) {
      health.database = { status: 'ERROR', message: e.message };
      health.overallStatus = 'ERROR';
      isHealthy = false;
      console.error('[HEALTH-CHECK] Database connection failed:', e.message);
    }

    try {
      await this.withdrawalQueue.isReady();
      await this.rawTxBroadcastQueue.isReady();
    } catch (e) {
      health.queue = { status: 'ERROR', message: e.message };
      health.overallStatus = 'ERROR';
      isHealthy = false;
      console.error('[HEALTH-CHECK] Queue connection failed:', e.message);
    }

    return { healthStatus: health, isHealthy };
  }
}

// Export a singleton instance so the state is managed in one place
module.exports = new WithdrawalManager();