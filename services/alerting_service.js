/**
 * A simple service for sending alerts.
 * In a real production environment, this would integrate with services like:
 * - PagerDuty (for critical, on-call alerts)
 * - Slack (for team notifications)
 * - Sentry, DataDog (for error tracking and monitoring)
 * - Email (for reports or less critical notifications)
 */
class AlertingService {
  /**
   * Sends an alert for a critical event.
   * @param {string} title - The title of the alert.
   * @param {object} details - An object containing details about the event.
   */
  async sendAlert(title, details) {
    console.error('\n==================== [CRITICAL ALERT] ====================');
    console.error(`Title: ${title}`);
    console.error('Details:', JSON.stringify(details, null, 2));
    console.error('========================================================\n');

    // Example integration with a webhook-based service like Slack or PagerDuty
    const webhookUrl = process.env.ALERTING_WEBHOOK_URL;
    if (webhookUrl) {
      // The 'fetch' API is available in Node.js v18+
      // For older versions, you might use a library like 'axios'.
      // await fetch(webhookUrl, { ... });
    }
  }
}

module.exports = new AlertingService();