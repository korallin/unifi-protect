/* Copyright(C) 2021, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-api.ts: Our UniFi Protect API implementation.
 */
import {
  PROTECT_API_ERROR_LIMIT,
  PROTECT_API_RETRY_INTERVAL,
  PROTECT_API_TIMEOUT,
  PROTECT_EVENTS_HEARTBEAT_INTERVAL,
  PROTECT_LOGIN_REFRESH_INTERVAL
} from "./settings";
import {
  ProtectCameraChannelConfigInterface,
  ProtectCameraConfig,
  ProtectCameraConfigInterface,
  ProtectCameraConfigPayload,
  ProtectNvrBootstrap,
  ProtectNvrUserConfig
} from "./protect-types";
import fetch, { FetchError, Headers, RequestInfo, RequestInit, Response } from "node-fetch";
import https from "https";
import { AbortController } from "abort-controller";
import { Logging } from "./logging";
import WebSocket from "ws";
import util from "util";

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

/*
 * The UniFi Protect API is largely undocumented and has been reverse engineered mostly through
 * the web interface, and trial and error.
 *
 * Here's how the UniFi Protect API works:
 *
 * 1. Login to the UniFi Protect NVR device and acquire security credentials for further calls to the API.
 *
 * 2. Enumerate the list of UniFi Protect devices by calling the bootstrap URL. This
 *    contains almost everything you would want to know about this particular UniFi Protect NVR
 *    installation.
 *
 * Those are the basics and gets us up and running.
 */

export class ProtectApi {
  private apiErrorCount: number;
  private apiLastSuccess: number;
  public bootstrap!: ProtectNvrBootstrap | null;
  public Cameras!: ProtectCameraConfig[] | undefined;
  private debug: (message: string, ...parameters: unknown[]) => void;
  private eventHeartbeatTimer!: NodeJS.Timeout;
  public eventListener!: WebSocket | null;
  public eventListenerConfigured!: boolean;
  private headers!: Headers;
  public isAdminUser!: boolean;
  private log: Logging;
  private loggedIn!: boolean;
  private loginAge!: number;
  private nvrAddress: string;
  private password: string;
  private username: string;
  private pendingLogin?: Promise<boolean>;

  // Initialize this instance with our login information.
  constructor(debug: (message: string, ...parameters: unknown[]) => void, log: Logging, nvrAddress: string, username: string, password: string, public disableKeepAlive?: boolean) {
    this.apiErrorCount = 0;
    this.apiLastSuccess = 0;
    this.debug = debug;
    this.log = log;
    this.nvrAddress = nvrAddress;
    this.username = username;
    this.password = password;

    this.clearLoginCredentials();
  }

  // Identify which NVR device type we're logging into and acquire a CSRF token if needed.
  private async acquireToken(): Promise<boolean> {

    // We only need to acquire a token if we aren't already logged in, or we don't already have a token,
    // or don't know which device type we're on.
    if (this.loggedIn || this.headers.has("X-CSRF-Token") || this.headers.has("Authorization")) {
      return true;
    }

    // UniFi OS has cross-site request forgery protection built into it's web management UI.
    // We use this fact to fingerprint it by connecting directly to the supplied NVR address
    // and see ifing there's a CSRF token waiting for us.
    const response = await this.fetch("https://" + this.nvrAddress, { method: "GET" }, false);

    if (response?.ok) {
      const csrfToken = response.headers.get("X-CSRF-Token");

      // We found a token.
      if (csrfToken) {
        this.headers.set("X-CSRF-Token", csrfToken);
        return true;
      }
    }

    // Couldn't deduce what type of NVR device we were connecting to.
    return false;
  }

  // Log into UniFi Protect.
  private async loginWrapped(): Promise<boolean> {
    const now = Date.now();

    // Is it time to renew our credentials?
    if (now > (this.loginAge + (PROTECT_LOGIN_REFRESH_INTERVAL * 1000))) {
      this.clearLoginCredentials();
    }

    // If we're already logged in, and it's not time to renew our credentials, we're done.
    if (this.loggedIn) {
      return true;
    }

    // Make sure we have a token, or get one if needed.
    if (!(await this.acquireToken())) {
      this.clearLoginCredentials();
      return false;
    }

    // Log us in.
    const response = await this.fetch(this.authUrl(), {
      body: JSON.stringify({ password: this.password, username: this.username }),
      method: "POST"
    });

    if (!response?.ok) {
      this.clearLoginCredentials();
      return false;
    }

    // We're logged in.
    this.loggedIn = true;
    this.loginAge = now;

    // Configure headers.
    const csrfToken = response.headers.get("X-CSRF-Token");
    const cookie = response.headers.get("Set-Cookie");

    if (csrfToken && cookie && this.headers.has("X-CSRF-Token")) {

      this.headers.set("Cookie", cookie);
      this.headers.set("X-CSRF-Token", csrfToken);
      return true;
    }

    // Clear out our login credentials and reset for another try.
    this.clearLoginCredentials();

    return false;
  }

  private login(): Promise<boolean> {
    // coalesce multiple requests into a single login attempt.
    if (!this.pendingLogin) {
      this.pendingLogin = this.loginWrapped();
      this.pendingLogin.finally(() => this.pendingLogin = undefined);
    }
    return this.pendingLogin;
  }

  // Get our UniFi Protect NVR configuration.
  private async bootstrapProtect(): Promise<boolean> {
    // Log us in if needed.
    if (!(await this.login())) {
      return false;
    }

    const response = await this.fetch(this.bootstrapUrl(), { method: "GET" });

    if (!response?.ok) {
      this.log.error("%s: Unable to retrieve NVR configuration information from UniFi Protect. Will retry again later.",
        this.getNvrName());

      // Clear out our login credentials and reset for another try.
      this.clearLoginCredentials();
      return false;
    }

    // Now let's get our NVR configuration information.
    let data: ProtectNvrBootstrap | null = null;

    try {
      data = await response.json() as ProtectNvrBootstrap;
    } catch (error) {
      data = null;
      this.log.error("%s: Unable to parse response from UniFi Protect. Will retry again later.", this.getNvrName());
    }

    // No camera information returned.
    if (!data?.cameras) {
      this.log.error("%s: Unable to retrieve camera information from UniFi Protect. Will retry again later.", this.getNvrName());

      // Clear out our login credentials and reset for another try.
      this.clearLoginCredentials();
      return false;
    }

    // On launch, let the user know we made it.
    const firstRun = this.bootstrap ? false : true;
    this.bootstrap = data;

    if (firstRun) {
      this.log.info("%s: Connected to the Protect controller API (address: %s mac: %s).", this.getNvrName(), data.nvr.host, data.nvr.mac);
    }

    // Capture the bootstrap if we're debugging.
    this.debug(util.inspect(this.bootstrap, { colors: true, depth: null, sorted: true }));

    // Check for admin user privileges or role changes.
    this.checkAdminUserStatus(firstRun);

    // We're good. Now connect to the event listener API.
    return this.launchUpdatesListener();
  }

  // Connect to the realtime update events API.
  private async launchUpdatesListener(): Promise<boolean> {

    // Log us in if needed.
    if (!(await this.login())) {
      return false;
    }

    // If we already have a listener, we're already all set.
    if (this.eventListener) {
      return true;
    }

    const params = new URLSearchParams({ lastUpdateId: this.bootstrap?.lastUpdateId ?? "" });

    this.debug("Update listener: %s", this.updatesUrl() + "?" + params.toString());

    try {
      const ws = new WebSocket(this.updatesUrl() + "?" + params.toString(), {
        headers: {
          Cookie: this.headers.get("Cookie") ?? ""
        },
        rejectUnauthorized: false
      });

      if (!ws) {
        this.log.error("Unable to connect to the realtime update events API. Will retry again later.");
        this.eventListener = null;
        this.eventListenerConfigured = false;
        return false;
      }

      this.eventListener = ws;

      // Setup our heartbeat to ensure we can revive our connection if needed.
      this.eventListener.on("message", this.heartbeatEventListener.bind(this));
      this.eventListener.on("open", this.heartbeatEventListener.bind(this));
      this.eventListener.on("ping", this.heartbeatEventListener.bind(this));
      this.eventListener.on("close", () => {

        clearTimeout(this.eventHeartbeatTimer);

      });

      this.eventListener.on("error", (error) => {

        // If we're closing before fully established it's because we're shutting down the API - ignore it.
        if (error.message !== "WebSocket was closed before the connection was established") {
          this.log.error("%s: %s", this.getNvrName(), error);
        }

        this.eventListener?.terminate();
        this.eventListener = null;
        this.eventListenerConfigured = false;

      });

      this.log.info("%s: Connected to the UniFi realtime update events API.", this.getNvrName());
    } catch (error) {
      this.log.error("%s: Error connecting to the realtime update events API: %s", this.getNvrName(), error);
    }

    return true;
  }

  // Get the list of UniFi Protect devices associated with a NVR.
  public async refreshDevices(): Promise<boolean> {
    // Refresh the configuration from the NVR.
    if (!(await this.bootstrapProtect())) {
      return false;
    }

    this.debug(util.inspect(this.bootstrap, { colors: true, depth: null, sorted: true }));

    const newDeviceList: ProtectCameraConfig[] | undefined = this.bootstrap?.cameras;

    // Notify the user about any new devices that we've discovered.
    if (newDeviceList) {
      for (const newDevice of newDeviceList) {
        // We already know about this device.
        if (this.Cameras?.some((x: ProtectCameraConfig) => x.mac === newDevice.mac)) {
          continue;
        }

        // We only want to discover managed devices.
        if (!newDevice.isManaged) {
          continue;
        }

        // We've discovered a new device.
        this.log.info("%s: Discovered %s: %s.",
          this.getNvrName(), newDevice.modelKey, this.getDeviceName(newDevice, newDevice.name, true));

        this.debug(util.inspect(newDevice, { colors: true, depth: null, sorted: true }));
      }
    }

    // Notify the user about any devices that have disappeared.
    if (this.Cameras) {
      for (const existingDevice of this.Cameras) {

        // This device still is visible.
        if (newDeviceList?.some((x: ProtectCameraConfig) => x.mac === existingDevice.mac)) {
          continue;
        }

        // We've had a device disappear.
        this.debug("%s: Detected %s removal.", this.getFullName(existingDevice), existingDevice.modelKey);

        this.debug(util.inspect(existingDevice, { colors: true, depth: null, sorted: true }));
      }
    }

    // Save the updated list of devices.
    this.Cameras = newDeviceList;
    return true;
  }

  // Validate if all RTSP channels enabled on all cameras.
  public isAllRtspConfigured(): boolean {

    // Look for any cameras with any non-RTSP enabled channels.
    return this.bootstrap?.cameras?.some(camera => camera.channels?.some(channel => !channel.isRtspEnabled)) ? true : false;
  }

  // Check admin privileges.
  private checkAdminUserStatus(firstRun = false): boolean {
    if (!this.bootstrap?.users) {
      return false;
    }

    // Save our prior state so we can detect role changes without having to restart.
    const oldAdminStatus = this.isAdminUser;

    // Find this user.
    const user = this.bootstrap?.users.find((x: ProtectNvrUserConfig) => x.id === this.bootstrap?.authUserId);

    if (!user?.allPermissions) {
      return false;
    }

    // Let's figure out this user's permissions.
    let newAdminStatus = false;
    for (const entry of user.allPermissions) {
      // Each permission line exists as: permissiontype:permissions:scope.
      const permType = entry.split(":");

      // We only care about camera permissions.
      if (permType[0] !== "camera") {
        continue;
      }

      // Get the individual permissions.
      const permissions = permType[1].split(",");

      // We found our administrative privileges - we're done.
      if (permissions.indexOf("write") !== -1) {
        newAdminStatus = true;
        break;
      }
    }

    this.isAdminUser = newAdminStatus;

    // Only admin users can activate RTSP streams. Inform the user on startup, or if we detect a role change.
    if (firstRun && !this.isAdminUser) {
      this.log.info("%s: The user '%s' requires the Administrator role in order to automatically configure camera RTSP streams.",
        this.getNvrName(), this.username);
    } else if (!firstRun && (oldAdminStatus !== this.isAdminUser)) {
      this.log.info("%s: Detected a role change for user '%s': the Administrator role has been %s.",
        this.getNvrName(), this.username, this.isAdminUser ? "enabled" : "disabled");
    }

    return true;
  }

  private async checkCameraState(device: ProtectCameraConfigInterface): Promise<boolean> {
    // Log us in if needed.
    if (!(await this.login())) {
      return false;
    }

    // Only admin users can activate RTSP streams.
    if (!this.isAdminUser) {
      return false;
    }

    // At the moment, we only know about camera devices.
    if (device.modelKey !== "camera") {
      return false;
    }

    return true;
  }

  // Enable RTSP stream support on an attached Protect device.
  public async updateChannels(device: ProtectCameraConfigInterface): Promise<ProtectCameraConfig | null> {
    if (!(await this.checkCameraState(device))) {
      return null;
    }

    // Update Protect with the new configuration.
    const response = await this.fetch(this.camerasUrl() + "/" + device.id, {
      body: JSON.stringify({ channels: device.channels }),
      method: "PATCH"
    }, true, false);

    // Since we took responsibility for interpreting the outcome of the fetch, we need to check for
    // errors for ourself.
    if (!response || !response?.ok) {
      this.apiErrorCount++;

      if (response?.status === 403) {
        this.log.error("%s: Insufficient privileges to enable RTSP on all channels. Please ensure this username has the Administrator role assigned in UniFi Protect.",
          this.getFullName(device));
      } else {
        this.log.error("%s: Unable to enable RTSP on all channels: %s.", this.getFullName(device), response?.status);
      }

      // We still return our camera object if there is at least one RTSP channel enabled.
      return device;
    }

    // Since we have taken responsibility for decoding response types, we need to reset our API backoff count.
    this.apiErrorCount = 0;
    this.apiLastSuccess = Date.now();

    // Everything worked, save the new channel array.
    return await response.json() as ProtectCameraConfig;
  }

  // Enable RTSP stream support on an attached Protect device.
  public async enableRtsp(device: ProtectCameraConfigInterface): Promise<ProtectCameraConfig | null> {
    if (!(await this.checkCameraState(device))) {
      return null;
    }

    // Do we have any non-RTSP enabled channels? If not, we're done.
    if (!device.channels?.some(channel => !channel.isRtspEnabled)) {
      return device;
    }

    // Enable RTSP on all available channels.
    device.channels = device.channels.map((channel: ProtectCameraChannelConfigInterface) => {
      channel.isRtspEnabled = true;
      return channel;
    });

    return this.updateChannels(device);
  }

  // Update a camera object.
  public async updateCamera(device: ProtectCameraConfig, payload: ProtectCameraConfigPayload): Promise<ProtectCameraConfig | null> {

    // No device object, we're done.
    if (!device) {
      return null;
    }

    // Log us in if needed.
    if (!(await this.login())) {
      return null;
    }

    // Only admin users can show messages on doorbells.
    if (!this.isAdminUser) {
      return null;
    }

    this.debug("%s: %s", this.getFullName(device), util.inspect(payload, { colors: true, depth: null, sorted: true }));

    // Update Protect with the new configuration.
    const response = await this.fetch(this.camerasUrl() + "/" + device.id, {
      body: JSON.stringify(payload),
      method: "PATCH"
    });

    if (!response?.ok) {
      this.log.error("%s: Unable to configure the camera: %s.", this.getFullName(device), response?.status);
      return null;
    }

    // We successfully set the message, return the updated device object.
    return await response.json() as ProtectCameraConfig;
  }

  // Utility to generate a nicely formatted NVR string.
  public getNvrName(): string {

    // Our NVR string, if it exists, appears as:
    // NVR [NVR Type].
    // Otherwise, we appear as NVRaddress.
    if (this.bootstrap?.nvr) {
      return this.bootstrap.nvr.name + " [" + this.bootstrap.nvr.type + "]";
    } else {
      return this.nvrAddress;
    }
  }

  // Utility to generate a nicely formatted device string.
  public getDeviceName(camera: ProtectCameraConfig, name = camera?.name, cameraInfo = false): string {

    // Validate our inputs.
    if (!camera) {
      return "";
    }

    // A completely enumerated device will appear as:
    // Camera [Camera Type] (address: IP address, mac: MAC address).
    return name + " [" + camera.type + "]" +
      (cameraInfo ? " (address: " + camera.host + " mac: " + camera.mac + ")" : "");
  }

  // Utility to generate a nicely formatted NVR and device string.
  public getFullName(camera: ProtectCameraConfig): string {
    const cameraName = this.getDeviceName(camera);

    // Returns: NVR [NVR Type] Camera [Camera Type]
    return this.getNvrName() + (cameraName.length > 0 ? " " + cameraName : "");
  }

  // Return the URL to directly access cameras, adjusting for Protect NVR variants.
  public camerasUrl(): string {

    // Boostrapping a UniFi OS device is done through: https://protect-nvr-ip/proxy/protect/api/cameras/CAMERAID.
    return "https://" + this.nvrAddress + "/proxy/protect/api/cameras";
  }

  // Return the right authentication URL, depending on which Protect NVR platform we are using.
  private authUrl(): string {

    // Authenticating a UniFi OS device is done through: https://protect-nvr-ip/api/auth/login.
    return "https://" + this.nvrAddress + "/api/auth/login";
  }

  // Return the right bootstrap URL, depending on which Protect NVR platform we are using.
  private bootstrapUrl(): string {

    // Boostrapping a UniFi OS device is done through: https://protect-nvr-ip/proxy/protect/api/bootstrap.
    return "https://" + this.nvrAddress + "/proxy/protect/api/bootstrap";
  }

  // Return the realtime system events API URL.
  private systemUrl(): string {

    return "wss://" + this.nvrAddress + "/api/ws/system";
  }

  // Return the realtime update events API URL.
  private updatesUrl(): string {

    return "wss://" + this.nvrAddress + "/proxy/protect/ws/updates";
  }

  // Utility to check the heartbeat of our listener.
  private heartbeatEventListener(): void {

    // Clear out our last timer and set a new one.
    clearTimeout(this.eventHeartbeatTimer);

    // We use terminate() to immediately destroy the connection, instead of close(), which waits for the close timer.
    this.eventHeartbeatTimer = setTimeout(() => {
      this.eventListener?.terminate();
      this.eventListener = null;
      this.eventListenerConfigured = false;
    }, PROTECT_EVENTS_HEARTBEAT_INTERVAL * 1000);
  }

  // Utility to clear out old login credentials or attempts.
  public clearLoginCredentials(): void {
    this.isAdminUser = false;
    this.loggedIn = false;
    this.loginAge = 0;
    this.bootstrap = null;

    // Shutdown any event listeners, if we have them.
    this.eventListener?.terminate();
    this.eventListener = null;
    this.eventListenerConfigured = false;

    // Initialize the headers we need.
    this.headers = new Headers();
    this.headers.set("Content-Type", "application/json");
  }

  // Utility to let us streamline error handling and return checking from the Protect API.
  public async loginFetch(url: RequestInfo, options: RequestInit = { method: "GET" }, logErrors = true, decodeResponse = true): Promise<Response | null> {
    if (!(await this.login())) {
      return null;
    }

    return this.fetch(url, options, logErrors, decodeResponse);
  }

  // Utility to let us streamline error handling and return checking from the Protect API.
  public async fetch(url: RequestInfo, options: RequestInit = { method: "GET" }, logErrors = true, decodeResponse = true): Promise<Response | null> {
    let response: Response;

    const controller = new AbortController();

    // Ensure API responsiveness and guard against hung connections.
    const timeout = setTimeout(() => {
      controller.abort();
    }, 1000 * PROTECT_API_TIMEOUT);

    options.agent = httpsAgent;
    options.headers = this.headers;
    options.signal = controller.signal;

    try {

      const now = Date.now();

      // Throttle this after PROTECT_API_ERROR_LIMIT attempts.
      if (this.apiErrorCount >= PROTECT_API_ERROR_LIMIT) {

        // Let the user know we've got an API problem.
        if (this.apiErrorCount === PROTECT_API_ERROR_LIMIT) {

          this.log.info("%s: Throttling API calls due to errors with the %s previous attempts. I'll retry again in %s minutes.",
            this.getNvrName(), this.apiErrorCount, PROTECT_API_RETRY_INTERVAL / 60);
          this.apiErrorCount++;
          this.apiLastSuccess = now;
          return null;
        }

        // Throttle our API calls.
        if ((this.apiLastSuccess + (PROTECT_API_RETRY_INTERVAL * 1000)) > now) {
          return null;
        }

        // Inform the user that we're out of the penalty box and try again.
        this.log.info("%s: Resuming connectivity to the UniFi Protect API after throttling for %s minutes.",
          this.getNvrName(), PROTECT_API_RETRY_INTERVAL / 60);
        this.apiErrorCount = 0;
      }

      response = await fetch(url, options);

      // The caller will sort through responses instead of us.
      if (!decodeResponse) {
        return response;
      }

      // Bad username and password.
      if (response.status === 401) {
        this.log.error("Invalid login credentials given. Please check your login and password.");
        this.apiErrorCount++;
        return null;
      }

      // Insufficient privileges.
      if (response.status === 403) {
        this.apiErrorCount++;
        this.log.error("Insufficient privileges for this user. Please check the roles assigned to this user and ensure it has sufficient privileges.");
        return null;
      }

      // Some other unknown error occurred.
      if (!response.ok) {
        this.apiErrorCount++;
        this.log.error("API access error: %s - %s", response.status, response.statusText);
        return null;
      }

      this.apiLastSuccess = Date.now();
      this.apiErrorCount = 0;
      return response;

    } catch (error) {

      this.apiErrorCount++;

      if (error instanceof Error) {
        if (error.name === "AbortError") {
          this.log.error("%s: Controller API connection terminated because it was taking too long. This error can usually be safely ignored.", this.getNvrName());
          return null;
        }
      }

      if (error instanceof FetchError) {

        switch (error.code) {
          case "ECONNREFUSED":
            this.log.error("%s: Controller API connection refused.", this.getNvrName());
            break;

          case "ECONNRESET":
            this.log.error("%s: Controller API connection reset.", this.getNvrName());
            break;

          case "ENOTFOUND":
            this.log.error("%s: Hostname or IP address not found. Please ensure the address you configured for this UniFi Protect controller is correct.",
              this.getNvrName());
            break;

          default:
            if (logErrors) {
              this.log.error(error.message);
            }
        }
      }

      return null;

    } finally {

      // Clear out our response timeout if needed.
      clearTimeout(timeout);
    }
  }
}
