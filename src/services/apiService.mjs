// src/services/apiService.js
const API_BASE_URL = process.env.REACT_APP_API_URL || "http://localhost:5000";

class ApiService {
  constructor() {
    this.baseURL = API_BASE_URL;
  }

  /**
   * Get authorization header with Bearer token
   * @returns {Object} Headers object with authorization
   */
  getAuthHeaders() {
    const token = localStorage.getItem("token");
    return {
      "Content-Type": "application/json",
      ...(token && { Authorization: `Bearer ${token}` }),
    };
  }

  /**
   * Generic fetch wrapper with error handling
   * @param {string} endpoint - API endpoint
   * @param {Object} options - Fetch options
   * @returns {Promise} API response
   */
  async fetchApi(endpoint, options = {}) {
    const url = `${this.baseURL}${endpoint}`;
    const config = {
      headers: this.getAuthHeaders(),
      ...options,
      headers: {
        ...this.getAuthHeaders(),
        ...options.headers,
      },
    };

    try {
      const response = await fetch(url, config);
      const data = await response.json();

      if (!response.ok) {
        // Handle token expiry
        if (response.status === 401) {
          localStorage.removeItem("token");
          window.location.reload();
          throw new Error("Session expired. Please login again.");
        }
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      return data;
    } catch (error) {
      console.error(`API Error [${endpoint}]:`, error);
      throw error;
    }
  }

  // === Authentication Methods ===

  /**
   * Login user
   * @param {string} username
   * @param {string} password
   * @returns {Promise} Login response
   */
  async login(username, password) {
    return this.fetchApi("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
  }

  /**
   * Register new user
   * @param {string} username
   * @param {string} password
   * @returns {Promise} Registration response
   */
  async register(username, password) {
    return this.fetchApi("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
  }

  /**
   * Verify token validity
   * @returns {Promise} Verification response
   */
  async verifyToken() {
    return this.fetchApi("/api/auth/verify");
  }

  /**
   * Get user profile
   * @returns {Promise} Profile response
   */
  async getProfile() {
    return this.fetchApi("/api/auth/profile");
  }

  /**
   * Logout user
   * @returns {Promise} Logout response
   */
  async logout() {
    return this.fetchApi("/api/auth/logout", {
      method: "POST",
    });
  }

  // === IoT Data Methods ===

  /**
   * Get current temperature data
   * @returns {Promise} Current temperature response
   */
  async getCurrentTemperature() {
    return this.fetchApi("/api/sensor/current");
  }

  /**
   * Get today's temperature aggregates
   * @returns {Promise} Today's aggregates response
   */
  async getTodayAggregates() {
    return this.fetchApi("/api/sensor/aggregate/today");
  }

  /**
   * Get realtime statistics
   * @returns {Promise} Realtime stats response
   */
  async getRealtimeStats() {
    return this.fetchApi("/api/sensor/realtime/stats");
  }

  /**
   * Get historical data by date
   * @param {string} date - Date in YYYY-MM-DD format
   * @returns {Promise} Historical data response
   */
  async getHistoricalData(date) {
    return this.fetchApi(`/api/sensor/history/${date}`);
  }

  /**
   * Get system status
   * @returns {Promise} System status response
   */
  async getSystemStatus() {
    return this.fetchApi("/api/system/status");
  }

  /**
   * Get system statistics
   * @returns {Promise} System stats response
   */
  async getSystemStats() {
    return this.fetchApi("/api/stats");
  }

  /**
   * Get system logs
   * @param {number} limit - Number of logs to fetch
   * @param {string} level - Log level filter
   * @returns {Promise} Logs response
   */
  async getSystemLogs(limit = 50, level = null) {
    const params = new URLSearchParams();
    params.append("limit", limit);
    if (level) params.append("level", level);

    return this.fetchApi(`/api/logs?${params.toString()}`);
  }

  /**
   * Get backup list
   * @returns {Promise} Backup list response
   */
  async getBackupList() {
    return this.fetchApi("/api/backup");
  }

  /**
   * Get backup data by date
   * @param {string} date - Date in YYYY-MM-DD format
   * @returns {Promise} Backup data response
   */
  async getBackupData(date) {
    return this.fetchApi(`/api/backup/${date}`);
  }

  // === Debug Methods ===

  /**
   * Force process buffer (debug)
   * @returns {Promise} Process buffer response
   */
  async forceProcessBuffer() {
    return this.fetchApi("/api/debug/process-buffer", {
      method: "POST",
    });
  }

  /**
   * Force process aggregate (debug)
   * @returns {Promise} Process aggregate response
   */
  async forceProcessAggregate() {
    return this.fetchApi("/api/debug/process-aggregate", {
      method: "POST",
    });
  }
}

// Export singleton instance
export const apiService = new ApiService();
export default apiService;
