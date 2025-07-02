/**
 * API Routes for the Withdrawal Activation Service
 * (Example using Express.js framework)
 */

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const router = express.Router();
const withdrawalManager = require('../services/withdrawal_manager');
// const authMiddleware = require('./auth_middleware'); // Assuming an auth middleware exists

/**
 * GET /api/v2/withdrawal/health
 * A health check endpoint for monitoring services (e.g., load balancers, Kubernetes).
 * This should be publicly accessible and not behind auth middleware.
 */
router.get('/health', async (_req, res) => {
  const { healthStatus, isHealthy } = await withdrawalManager.checkHealth();
  if (isHealthy) {
    return res.status(200).json(healthStatus);
  }
  // Return 503 Service Unavailable if any dependency is down.
  return res.status(503).json(healthStatus);
});

// router.use(authMiddleware); // All routes below would be protected

/**
 * POST /api/v2/withdrawal/initiate
 * Endpoint for the bank to submit a partially-signed multi-sig withdrawal request.
 * This is the primary, most secure endpoint.
 */
router.post(
  '/initiate',
  // Input validation middleware
  body('request_id').isString().notEmpty(),
  body('treasury_contract_address').isEthereumAddress(),
  body('destination_address').isEthereumAddress(),
  body('token_contract_address').isEthereumAddress(),
  body('amount').isDecimal(),
  body('partially_signed_tx').matches(/^0x[a-fA-F0-9]+$/),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const result = await withdrawalManager.processNewRequest(req.body);
      // 202 Accepted is the correct response for an async process
      res.status(202).json({ status: 'PENDING', ...result });
    } catch (error) {
      // Handle potential errors like duplicate request_id
      res.status(409).json({ error: error.message });
    }
  }
);

/**
 * POST /api/v2/withdrawal/cancel
 * Endpoint for the bank to cancel a pending request before it's fully signed.
 */
router.post(
  '/cancel',
  body('request_id').isString().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const result = await withdrawalManager.cancelRequest(req.body.request_id);
      res.status(200).json({ status: 'CANCELLED', ...result });
    } catch (error) {
      // Handle cases where the request is not found or already processed
      res.status(404).json({ error: error.message });
    }
  }
);

/**
 * GET /api/v2/withdrawal/status/:requestId
 * Endpoint for the client to poll for the status of a specific withdrawal request.
 */
router.get(
  '/status/:requestId',
  param('requestId').isString().notEmpty(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const result = await withdrawalManager.getRequestStatus(
        req.params.requestId
      );
      res.status(200).json(result);
    } catch (error) {
      res.status(404).json({ error: error.message });
    }
  }
);

/**
 * GET /api/v2/withdrawal/list
 * Endpoint for the dashboard to get a list of all withdrawal requests.
 */
router.get(
  '/list',
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('pageSize').optional().isInt({ min: 1, max: 100 }).toInt(),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { page = 1, pageSize = 10 } = req.query;
      const paginatedResult = await withdrawalManager.getAllRequests({ page, pageSize });
      res.status(200).json(paginatedResult);
    } catch (error) {
      res.status(500).json({ error: 'An internal error occurred while retrieving requests.' });
    }
  }
);

/**
 * POST /api/v2/broadcast/raw-transaction
 * A simpler endpoint for clients who manage their own keys and want to use
 * our service only for reliable broadcasting and monitoring.
 */
router.post(
  '/broadcast/raw-transaction',
  body('raw_tx').matches(/^0x[a-fA-F0-9]+$/).withMessage('Invalid raw transaction format.'),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { raw_tx } = req.body;
      // Assuming your auth middleware adds a client ID to the request object
      const clientId = req.user?.clientId;
      const result = await withdrawalManager.processRawTransactionBroadcast(raw_tx, clientId);
      res.status(202).json(result);
    } catch (error) {
      console.error('[API-ERROR] Failed to process raw transaction broadcast:', error);
      res.status(500).json({ error: 'An internal error occurred.' });
    }
  }
);

module.exports = router;