// Cargo Ops toolbar panel host (plain script, no build step).
//
// Loads http://127.0.0.1:<port>/panel into the iframe while the toolbar window is open and
// blanks it when the window closes. The Cargo Ops page posts { source: "cargo-ops-panel",
// type: "ready" } to this page once it has loaded; until that message arrives from the
// expected origin the fallback ("Start Cargo Ops (scripts\start-cargo-ops.cmd)") is shown and
// the iframe is reloaded every few seconds. Once loaded, the Cargo Ops page reconnects to the
// connector by itself (it shows CONNECTOR OFFLINE meanwhile), so no further reloads happen.
//
// In the simulator the page is a custom element built on the simulator's TemplateElement and
// follows the toolbar window's panelActive / panelInactive events. Opened in an ordinary
// browser (for a look without the simulator) it simply starts.

(function (global) {
  "use strict";

  var DEFAULT_PORT = 4311;
  /** How long to wait for the ready message before showing the fallback, ms. */
  var READY_TIMEOUT_MS = 4000;
  /** How often to try again while Cargo Ops is not reachable, ms. */
  var RETRY_MS = 5000;

  /** Port and URLs from window.CARGO_OPS_PANEL_CONFIG; anything invalid falls back to 4311. */
  function readConfig(config) {
    var port = config && config.port;
    if (typeof port === "string" && /^[0-9]+$/.test(port)) port = Number(port);
    if (typeof port !== "number" || port % 1 !== 0 || port < 1 || port > 65535) {
      port = DEFAULT_PORT;
    }
    var origin = "http://127.0.0.1:" + port;
    return { port: port, origin: origin, url: origin + "/panel" };
  }

  /** Only the constant ready message from the Cargo Ops origin counts. */
  function isReadyMessage(event, origin) {
    var data = event && event.data;
    return (
      !!event &&
      event.origin === origin &&
      !!data &&
      typeof data === "object" &&
      data.source === "cargo-ops-panel" &&
      data.type === "ready"
    );
  }

  /**
   * Wire the iframe and the fallback in `doc`. Returns { start, stop, state }.
   * `timers` defaults to the window's setTimeout / clearTimeout (tests pass fakes).
   */
  function createHost(doc, win, config, timers) {
    var settings = readConfig(config);
    var setT = (timers && timers.setTimeout) || win.setTimeout.bind(win);
    var clearT = (timers && timers.clearTimeout) || win.clearTimeout.bind(win);
    var frame = doc.getElementById("CargoOpsFrame");
    var fallback = doc.getElementById("CargoOpsFallback");
    var address = doc.getElementById("CargoOpsAddress");
    var state = { active: false, ready: false, attempts: 0, fallbackShown: false };
    var timer = null;

    if (address) address.textContent = settings.origin;

    function showFallback(show) {
      state.fallbackShown = show;
      if (fallback) {
        if (show) fallback.classList.remove("is-hidden");
        else fallback.classList.add("is-hidden");
      }
      if (frame) {
        if (show) frame.classList.add("is-hidden");
        else frame.classList.remove("is-hidden");
      }
    }

    function clearTimer() {
      if (timer !== null) clearT(timer);
      timer = null;
    }

    function load() {
      if (!state.active || state.ready) return;
      state.attempts += 1;
      if (frame) frame.src = settings.url;
      clearTimer();
      timer = setT(function () {
        timer = null;
        if (!state.active || state.ready) return;
        showFallback(true);
        timer = setT(load, RETRY_MS);
      }, READY_TIMEOUT_MS);
    }

    function onMessage(event) {
      if (!state.active || !isReadyMessage(event, settings.origin)) return;
      state.ready = true;
      clearTimer();
      showFallback(false);
    }

    win.addEventListener("message", onMessage);

    return {
      settings: settings,
      state: state,
      start: function () {
        if (state.active) return;
        state.active = true;
        state.ready = false;
        state.attempts = 0;
        showFallback(false);
        load();
      },
      stop: function () {
        state.active = false;
        state.ready = false;
        clearTimer();
        // A closed toolbar window costs nothing: unload the page and its WebSocket.
        if (frame) frame.src = "about:blank";
      },
    };
  }

  global.CargoOpsPanelHost = {
    DEFAULT_PORT: DEFAULT_PORT,
    READY_TIMEOUT_MS: READY_TIMEOUT_MS,
    RETRY_MS: RETRY_MS,
    readConfig: readConfig,
    isReadyMessage: isReadyMessage,
    createHost: createHost,
  };

  function hostFor(element) {
    return createHost(
      (element && element.ownerDocument) || global.document,
      global,
      global.CARGO_OPS_PANEL_CONFIG,
    );
  }

  if (typeof global.TemplateElement === "function" && global.customElements) {
    // Inside the simulator: follow the toolbar window (community in-game panel pattern).
    var Base = global.TemplateElement;
    var CargoOpsPanelElement = class extends Base {
      connectedCallback() {
        if (super.connectedCallback) super.connectedCallback();
        var host = hostFor(this);
        var ui = this.querySelector("ingame-ui");
        if (ui && typeof ui.addEventListener === "function") {
          ui.addEventListener("panelActive", function () {
            host.start();
          });
          ui.addEventListener("panelInactive", function () {
            host.stop();
          });
        } else {
          host.start();
        }
      }
    };
    global.customElements.define("cargo-ops-panel", CargoOpsPanelElement);
    if (typeof global.checkAutoload === "function") global.checkAutoload();
  } else if (global.document && !global.CARGO_OPS_PANEL_NO_AUTOSTART) {
    // An ordinary browser: start once the page is there.
    var begin = function () {
      if (global.document.getElementById("CargoOpsFrame")) hostFor(null).start();
    };
    if (global.document.readyState === "loading") {
      global.document.addEventListener("DOMContentLoaded", begin);
    } else {
      begin();
    }
  }
})(window);
