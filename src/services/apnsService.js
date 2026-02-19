/**
 * APNs Service
 * Handles sending push notifications to iOS devices via Apple Push Notification service
 */

const http2 = require('http2');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

class APNsService {
  constructor() {
    this.keyId = process.env.APNS_KEY_ID;
    this.teamId = process.env.APNS_TEAM_ID;
    this.bundleId = process.env.APNS_BUNDLE_ID || 'com.studioaz.tattoo';
    this.keyPath = process.env.APNS_KEY_PATH || path.join(__dirname, '../certs/AuthKey.p8');
    this.isProduction = process.env.APNS_ENVIRONMENT === 'production';

    // Cache JWT token (valid for 1 hour, refresh every 50 minutes)
    this.jwtToken = null;
    this.jwtExpiry = null;

    // Load the private key
    this.privateKey = null;
    this.loadPrivateKey();
  }

  loadPrivateKey() {
    try {
      // Try file path first
      if (fs.existsSync(this.keyPath)) {
        this.privateKey = fs.readFileSync(this.keyPath, 'utf8');
        console.log('✅ APNs private key loaded from file');
        return;
      }

      // Fallback: read from APNS_PRIVATE_KEY env var (for Render deployment)
      if (process.env.APNS_PRIVATE_KEY) {
        this.privateKey = process.env.APNS_PRIVATE_KEY;
        console.log('✅ APNs private key loaded from environment variable');
        return;
      }

      console.warn('⚠️ APNs private key not found at:', this.keyPath);
      console.warn('   Push notifications will be disabled until key is configured');
    } catch (error) {
      console.error('❌ Error loading APNs private key:', error.message);
    }
  }

  /**
   * Generate a JWT token for APNs authentication
   */
  generateJWT() {
    if (!this.privateKey || !this.keyId || !this.teamId) {
      throw new Error('APNs not configured: missing private key, keyId, or teamId');
    }

    const now = Math.floor(Date.now() / 1000);

    // Return cached token if still valid (50 minutes)
    if (this.jwtToken && this.jwtExpiry && now < this.jwtExpiry) {
      return this.jwtToken;
    }

    // Generate new JWT
    const token = jwt.sign(
      {
        iss: this.teamId,
        iat: now
      },
      this.privateKey,
      {
        algorithm: 'ES256',
        header: {
          alg: 'ES256',
          kid: this.keyId
        }
      }
    );

    this.jwtToken = token;
    this.jwtExpiry = now + (50 * 60); // 50 minutes

    return token;
  }

  /**
   * Get APNs host based on environment
   */
  getAPNsHost() {
    return this.isProduction
      ? 'api.push.apple.com'
      : 'api.sandbox.push.apple.com';
  }

  /**
   * Send a push notification to a device
   * @param {string} deviceToken - The APNs device token
   * @param {Object} notification - The notification payload
   * @param {Object} options - Additional options (silent, priority, etc.)
   */
  async send(deviceToken, notification, options = {}) {
    if (!this.privateKey) {
      console.warn('⚠️ APNs not configured, skipping push notification');
      return { success: false, error: 'APNs not configured' };
    }

    return new Promise((resolve) => {
      try {
        const jwt = this.generateJWT();
        const host = this.getAPNsHost();

        // Build the APNs payload
        const payload = this.buildPayload(notification, options);
        const payloadString = JSON.stringify(payload);

        // Create HTTP/2 connection
        const client = http2.connect(`https://${host}`);

        client.on('error', (err) => {
          console.error('❌ APNs connection error:', err);
          resolve({ success: false, error: err.message });
        });

        // Build headers
        const headers = {
          ':method': 'POST',
          ':path': `/3/device/${deviceToken}`,
          'authorization': `bearer ${jwt}`,
          'apns-topic': this.bundleId,
          'apns-push-type': options.silent ? 'background' : 'alert',
          'apns-priority': options.silent ? '5' : (options.priority || '10'),
          'apns-expiration': options.expiration || '0',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payloadString)
        };

        // Add collapse ID if provided (for replacing notifications)
        if (options.collapseId) {
          headers['apns-collapse-id'] = options.collapseId;
        }

        const req = client.request(headers);

        let responseData = '';

        req.on('response', (responseHeaders) => {
          const status = responseHeaders[':status'];

          req.on('data', (chunk) => {
            responseData += chunk;
          });

          req.on('end', () => {
            client.close();

            if (status === 200) {
              console.log(`✅ Push notification sent to ${deviceToken.substring(0, 8)}...`);
              resolve({ success: true });
            } else {
              let error = 'Unknown error';
              try {
                const parsed = JSON.parse(responseData);
                error = parsed.reason || error;
              } catch {}
              console.error(`❌ APNs error (${status}): ${error}`);
              resolve({ success: false, error, status });
            }
          });
        });

        req.on('error', (err) => {
          console.error('❌ APNs request error:', err);
          client.close();
          resolve({ success: false, error: err.message });
        });

        req.write(payloadString);
        req.end();

      } catch (error) {
        console.error('❌ Error sending push notification:', error);
        resolve({ success: false, error: error.message });
      }
    });
  }

  /**
   * Build APNs payload
   */
  buildPayload(notification, options) {
    const payload = {
      aps: {}
    };

    if (options.silent) {
      // Silent/background notification
      payload.aps['content-available'] = 1;
    } else {
      // Alert notification
      payload.aps.alert = {
        title: notification.title || 'Studio AZ',
        body: notification.body || ''
      };
      payload.aps.sound = notification.sound || 'default';

      if (notification.badge !== undefined) {
        payload.aps.badge = notification.badge;
      }
    }

    // Add custom data
    if (notification.data) {
      Object.assign(payload, notification.data);
    }

    // Add notification type
    if (notification.type) {
      payload.type = notification.type;
    }

    // Add appointment-specific data
    if (notification.appointmentId) {
      payload.appointmentId = notification.appointmentId;
    }
    if (notification.contactId) {
      payload.contactId = notification.contactId;
    }
    if (notification.contactName) {
      payload.contactName = notification.contactName;
    }

    return payload;
  }

  /**
   * Send a notification and a silent refresh to the same device
   * @param {string} deviceToken - The APNs device token
   * @param {Object} notification - The notification payload
   */
  async sendWithRefresh(deviceToken, notification) {
    // Send visible notification
    const alertResult = await this.send(deviceToken, notification, {
      collapseId: `appointment-${notification.appointmentId || 'update'}`
    });

    // Also send silent notification for calendar refresh
    const silentResult = await this.send(deviceToken, {
      type: 'calendar_refresh',
      appointmentId: notification.appointmentId
    }, {
      silent: true
    });

    return {
      alert: alertResult,
      silent: silentResult
    };
  }

  /**
   * Check if APNs is properly configured
   */
  isConfigured() {
    return !!(this.privateKey && this.keyId && this.teamId);
  }

  /**
   * Get configuration status for diagnostics
   */
  getConfigStatus() {
    return {
      privateKeyLoaded: !!this.privateKey,
      keyId: !!this.keyId,
      teamId: !!this.teamId,
      bundleId: this.bundleId,
      environment: this.isProduction ? 'production' : 'sandbox',
      isConfigured: this.isConfigured()
    };
  }
}

// Export singleton instance
module.exports = new APNsService();
