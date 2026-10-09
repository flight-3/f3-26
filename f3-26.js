const FLIGHT3_FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';
const flight3InertOwners = new WeakMap();

function createFlight3FocusTrap(container, { signal } = {}) {
  let active = false;
  let isolated = [];

  const getFocusable = () =>
    Array.from(container.querySelectorAll(FLIGHT3_FOCUSABLE_SELECTOR)).filter(
      (element) =>
        !element.hasAttribute("data-flight3-focus-guard") &&
        !element.hasAttribute("hidden") &&
        !element.matches(":disabled") &&
        !element.closest("[inert], [aria-hidden='true']") &&
        element.getClientRects().length > 0,
    );

  const guards = [document.createElement("span"), document.createElement("span")];
  guards.forEach((guard, index) => {
    guard.setAttribute("data-flight3-focus-guard", "");
    guard.tabIndex = 0;
    guard.style.cssText = "position:fixed;width:1px;height:1px;top:0;left:-2px;opacity:0;pointer-events:none";
    guard.addEventListener("focus", () => {
      if (!active) return;
      const focusable = getFocusable();
      const target = index === 0 ? focusable.at(-1) : focusable[0];
      (target || container).focus?.({ preventScroll: true });
    });
  });

  const onKeydown = (event) => {
    if (!active || event.key !== "Tab") return;

    const focusable = getFocusable();
    if (!focusable.length) {
      event.preventDefault();
      container.focus?.({ preventScroll: true });
      return;
    }

    // Native Tab order can include cross-origin verification iframes. Guards
    // wrap focus after those frames rather than skipping them at the last button.
  };

  document.addEventListener("keydown", onKeydown, signal ? { signal } : undefined);

  const trap = {
    activate() {
      if (active) return;
      active = true;
      container.prepend(guards[0]);
      container.append(guards[1]);
      // Isolate siblings at each ancestor level without inerting the modal itself.
      let node = container;
      while (node?.parentElement) {
        Array.from(node.parentElement.children).forEach((sibling) => {
          if (sibling === node || !(sibling instanceof HTMLElement)) return;
          let state = flight3InertOwners.get(sibling);
          if (!state) {
            state = { count: 0, original: sibling.inert };
            flight3InertOwners.set(sibling, state);
          }
          state.count += 1;
          sibling.inert = true;
          isolated.push(sibling);
        });
        node = node.parentElement;
        if (node === document.body) break;
      }
    },
    deactivate() {
      active = false;
      guards.forEach((guard) => guard.remove());
      isolated.forEach((element) => {
        const state = flight3InertOwners.get(element);
        if (!state || --state.count > 0) return;
        element.inert = state.original;
        flight3InertOwners.delete(element);
      });
      isolated = [];
    },
  };
  signal?.addEventListener("abort", () => trap.deactivate(), { once: true });
  return trap;
}

function runFlight3Initializers(context, initializers) {
  const cleanups = [];
  initializers.forEach((initializer) => {
    try {
      const cleanup = initializer(context);
      if (typeof cleanup === "function") cleanups.push(cleanup);
    } catch (error) {
      console.error(`Flight3: ${initializer.name || "component"} failed to initialize.`, error);
    }
  });
  return cleanups;
}

function enhanceFlight3Button(element, signal) {
  if (!element || element.matches("button, input, a[href]")) return;
  const role = element.getAttribute("role");
  const tabindex = element.getAttribute("tabindex");
  element.setAttribute("role", "button");
  if (tabindex === null) element.setAttribute("tabindex", "0");
  element.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      element.click();
    },
    signal ? { signal } : undefined,
  );
  signal?.addEventListener(
    "abort",
    () => {
      if (role === null) element.removeAttribute("role");
      else element.setAttribute("role", role);
      if (tabindex === null) element.removeAttribute("tabindex");
      else element.setAttribute("tabindex", tabindex);
    },
    { once: true },
  );
}

/* Persistent, opt-in analytics consent. No legacy fs-cc runtime is required. */
function initFlight3Consent({ gsap, setScrollLock }) {
  if (window.Flight3Consent) return window.Flight3Consent;
  let root = document.querySelector("[data-flight3-consent]");
  // A native Saddle copy can retain its existing wrapper. Adopt it only
  // when both components share that wrapper, outside the replaced page.
  if (!root) {
    const nativeBanner = document.querySelector('[fs-cc="banner"]');
    const nativePreferences = document.querySelector('[fs-cc="preferences"]');
    const candidate = nativeBanner?.parentElement;
    if (
      candidate &&
      nativePreferences?.parentElement === candidate &&
      candidate.matches(".cc, .flight3-consent") &&
      !candidate.closest("#swup")
    ) {
      root = candidate;
      root.setAttribute("data-flight3-consent", "");
    }
  }
  // Fail closed: no authored consent UI means no tracking scripts are loaded.
  if (!root || root.closest("#swup")) return null;
  const find = (role, legacy = role) => root.querySelector(`[data-consent="${role}"], [fs-cc="${legacy}"]`);
  const banner = find("banner");
  const preferences = find("preferences");
  const analyticsInput = root.querySelector('input[data-consent-category="analytics"], input[fs-cc-checkbox="analytics"]');
  if (!banner || !preferences || !analyticsInput) {
    console.warn("Flight3: consent markup is incomplete; analytics remains blocked.");
    return null;
  }

  // Cookie preferences are local UI, not a Webflow lead form. Scope this
  // normalization strictly to preferences; contact/newsletter forms stay native.
  preferences.classList.remove("w-form");
  preferences.querySelectorAll("form").forEach((form) => {
    ["data-wf-page-id", "data-wf-element-id", "data-turnstile-sitekey"].forEach((attribute) => form.removeAttribute(attribute));
  });
  preferences.querySelectorAll(".w-form-done, .w-form-fail").forEach((element) => {
    element.hidden = true;
  });
  // The original Saddle bottom Accept-all action is mislabeled as submit.
  preferences.querySelectorAll('.fs-cc-prefs_buttons-wrapper [fs-cc="submit"]').forEach((button) => {
    if (/^accept\s+all$/i.test(button.textContent.trim())) button.setAttribute("fs-cc", "allow");
  });

  const KEY = "flight3-consent-v1";
  const MAX_AGE = 180 * 24 * 60 * 60 * 1000;
  const GA_ID = "G-WW0BBFSERN";
  const CLARITY_ID = "rb1l0ittqn";
  const html = document.documentElement;
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  const trap = createFlight3FocusTrap(preferences);
  const gpc = () => navigator.globalPrivacyControl === true;
  const cleanURL = () => {
    const url = new URL(window.location.href);
    url.hash = "";
    return url.href;
  };
  const parse = (raw) => {
    try {
      const value = JSON.parse(raw);
      const now = Date.now();
      return value?.version === 1 &&
        typeof value.analytics === "boolean" &&
        Number.isFinite(value.timestamp) &&
        Number.isFinite(value.expires) &&
        value.timestamp <= now &&
        value.expires > now &&
        value.expires <= value.timestamp + MAX_AGE
        ? value
        : null;
    } catch {
      return null;
    }
  };
  const read = () => {
    try {
      return parse(localStorage.getItem(KEY));
    } catch {
      return null;
    }
  };

  let record = read();
  let allowed = Boolean(record?.analytics) && !gpc();
  let gaRequested = false;
  let clarityRequested = false;
  let gaConfigured = false;
  let navigating = false;
  let ready = false;
  let prefsOpen = false;
  let bannerVisible = false;
  let lastFocus = null;
  let expiryTimer = 0;
  let bannerTween = null;
  let prefsTween = null;
  let route = { url: cleanURL(), title: document.title, referrer: document.referrer, token: 0 };
  let sentToken = null;

  const setVisible = (element, visible) => {
    element.inert = !visible;
    element.setAttribute("aria-hidden", String(!visible));
  };
  const animate = (element, vars) =>
    gsap.to(element, {
      ...vars,
      duration: reduce.matches ? 0 : 0.3,
      ease: "power1.out",
      overwrite: true,
    });
  banner.setAttribute("role", "region");
  banner.setAttribute("aria-label", "Cookie choices");
  preferences.setAttribute("role", "dialog");
  preferences.setAttribute("aria-modal", "true");
  if (!preferences.hasAttribute("aria-label") && !preferences.hasAttribute("aria-labelledby")) {
    preferences.setAttribute("aria-label", "Privacy preferences");
  }
  preferences.tabIndex = -1;
  preferences.setAttribute("data-lenis-prevent", "");
  preferences.querySelectorAll('.banner_close-icon[fs-cc="close"], [data-consent="close"]').forEach((element) => {
    if (!element.hasAttribute("aria-label")) element.setAttribute("aria-label", "Close privacy preferences");
  });
  analyticsInput.setAttribute("aria-label", "Allow analytics and session recordings");
  // This implementation has no advertising/personalization integrations.
  root.querySelectorAll("[fs-cc-checkbox], [data-consent-category]").forEach((input) => {
    if (input === analyticsInput || !(input instanceof HTMLInputElement)) return;
    input.checked = false;
    input.disabled = true;
  });
  root.querySelectorAll('[fs-cc="interaction"]').forEach((element) => {
    element.hidden = true;
  });
  root.querySelectorAll("[data-consent], [fs-cc]").forEach((element) => {
    if (
      element.matches(
        '[data-consent="banner"], [data-consent="preferences"], [fs-cc="banner"], [fs-cc="preferences"], [fs-cc="interaction"]',
      )
    )
      return;
    enhanceFlight3Button(element);
  });
  gsap.set([banner, preferences], { display: "none" });
  setVisible(banner, false);
  setVisible(preferences, false);

  function syncInputs() {
    analyticsInput.checked = allowed;
    analyticsInput.disabled = gpc();
    root.querySelectorAll("[data-consent-gpc]").forEach((element) => {
      element.hidden = !gpc();
    });
    root.querySelectorAll(".fs-cc-prefs_status-button").forEach((button) => {
      const input = button.querySelector("input");
      button.classList.toggle("cc-active", Boolean(input?.checked));
    });
  }

  function showBanner(show) {
    if (bannerVisible === show) return;
    bannerVisible = show;
    bannerTween?.kill();
    banner.classList.toggle("cc-open", show);
    if (show) {
      setVisible(banner, true);
      gsap.set(banner, { display: "flex", yPercent: reduce.matches ? 0 : 100 });
      bannerTween = animate(banner, { yPercent: 0 });
    } else {
      setVisible(banner, false);
      bannerTween = animate(banner, {
        yPercent: reduce.matches ? 0 : 100,
        onComplete: () => {
          banner.style.display = "none";
        },
      });
    }
  }

  function updateBanner() {
    showBanner(
      ready &&
        !record &&
        !prefsOpen &&
        !navigating &&
        !html.matches(
          ".is-intro-pending, .is-intro-playing, .is-transitioning, .has-form-panel-open, .has-video-modal-open, .has-mobile-nav-open",
        ),
    );
  }

  function closePreferences({ immediate = false, restoreFocus = true } = {}) {
    if (!prefsOpen) return;
    prefsOpen = false;
    prefsTween?.kill();
    setVisible(preferences, false);
    preferences.classList.remove("cc-open");
    trap.deactivate();
    html.classList.remove("has-consent-preferences-open");
    setScrollLock("consent-preferences", false);
    const finish = () => {
      preferences.style.display = "none";
    };
    if (immediate || reduce.matches) finish();
    else prefsTween = animate(preferences, { y: 20, opacity: 0, onComplete: finish });
    if (restoreFocus && lastFocus?.isConnected) lastFocus.focus?.({ preventScroll: true });
    lastFocus = null;
    updateBanner();
  }

  function openPreferences(trigger = document.activeElement) {
    if (
      prefsOpen ||
      navigating ||
      html.matches(".is-intro-pending, .is-intro-playing, .has-form-panel-open, .has-video-modal-open, .has-mobile-nav-open")
    )
      return;
    lastFocus = trigger;
    prefsOpen = true;
    prefsTween?.kill();
    syncInputs();
    showBanner(false);
    setVisible(preferences, true);
    preferences.classList.add("cc-open");
    gsap.set(preferences, { display: "flex", y: reduce.matches ? 0 : 20, opacity: 0 });
    html.classList.add("has-consent-preferences-open");
    setScrollLock("consent-preferences", true);
    trap.activate();
    prefsTween = animate(preferences, { y: 0, opacity: 1 });
    preferences.focus({ preventScroll: true });
  }

  function consentSignals(granted) {
    const state = granted ? "granted" : "denied";
    window[`ga-disable-${GA_ID}`] = !granted;
    if (gaRequested)
      window.gtag?.("consent", "update", {
        analytics_storage: state,
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
      });
    if (clarityRequested)
      window.clarity?.("consentv2", {
        analytics_Storage: state,
        ad_Storage: "denied",
      });
  }

  function removeAnalyticsCookies() {
    // Only known analytics cookies; never remove Webflow/form/security cookies.
    const names = document.cookie
      .split(";")
      .map((part) => part.trim().split("=")[0])
      .filter((name) => /^(_ga(?:_|$)|_gid$|_gat(?:_|$)|_clck$|_clsk$)/.test(name));
    const host = window.location.hostname;
    const domains = ["", host];
    const labels = host.split(".");
    for (let index = 1; index < labels.length - 1; index += 1) domains.push(labels.slice(index).join("."));
    const paths = new Set(["/"]);
    const parts = window.location.pathname.split("/").filter(Boolean);
    parts.forEach((_, index) => paths.add("/" + parts.slice(0, index + 1).join("/")));
    names.forEach((name) =>
      domains.forEach((domain) =>
        paths.forEach((path) => {
          document.cookie = `${name}=; Max-Age=0; path=${path}; SameSite=Lax${domain ? `; domain=${domain}` : ""}`;
        }),
      ),
    );
  }

  function addScript(id, src, onError) {
    const script = document.createElement("script");
    script.id = id;
    script.async = true;
    script.src = src;
    script.setAttribute("data-swup-persist", id);
    script.addEventListener("error", onError, { once: true });
    document.head.append(script);
  }

  function loadTrackers() {
    if (!allowed || navigating) return;
    if (!gaRequested) {
      gaRequested = true;
      window.dataLayer = window.dataLayer || [];
      window.gtag =
        window.gtag ||
        function () {
          window.dataLayer.push(arguments);
        };
      window.gtag("consent", "default", {
        analytics_storage: "denied",
        ad_storage: "denied",
        ad_user_data: "denied",
        ad_personalization: "denied",
      });
      window.gtag("js", new Date());
      consentSignals(true);
      window.gtag("config", GA_ID, { send_page_view: false });
      gaConfigured = true;
      addScript("flight3-google-tag", `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`, () => {
        console.warn("Flight3: Google Analytics could not load; site functionality is unaffected.");
      });
    }
    if (!clarityRequested) {
      clarityRequested = true;
      window.clarity =
        window.clarity ||
        function () {
          (window.clarity.q = window.clarity.q || []).push(arguments);
        };
      consentSignals(true);
      addScript("flight3-clarity-tag", `https://www.clarity.ms/tag/${CLARITY_ID}`, () => {
        console.warn("Flight3: Clarity could not load; site functionality is unaffected.");
      });
    }
  }

  function trackRoute() {
    if (!allowed || navigating || sentToken === route.token) return;
    loadTrackers();
    if (!gaConfigured) return;
    sentToken = route.token;
    window.gtag("event", "page_view", {
      send_to: GA_ID,
      page_location: route.url,
      page_title: route.title,
      page_referrer: route.referrer,
    });
    // Clarity owns its history instrumentation. These are route tags, not
    // synthetic page views or personal/user identifiers.
    window.clarity?.("set", "flight3_page", document.querySelector("#swup")?.dataset.page || "page");
  }

  function apply(next, { source = "storage", persisted = Boolean(next) } = {}) {
    record = next;
    const nextAllowed = Boolean(record?.analytics) && !gpc();
    const mustReload = !nextAllowed && (gaRequested || clarityRequested);
    allowed = nextAllowed;
    consentSignals(allowed);
    syncInputs();
    window.clearTimeout(expiryTimer);
    if (record) expiryTimer = window.setTimeout(() => apply(read()), Math.min(record.expires - Date.now() + 10, 2147483647));
    document.dispatchEvent(
      new CustomEvent("flight3:consent-updated", {
        detail: { essential: true, analytics: allowed, source, persisted },
      }),
    );
    if (mustReload) {
      removeAnalyticsCookies();
      // Denied consent modes may still send cookieless data. A native reload
      // unloads both SDKs; the saved opt-out prevents them loading again.
      window.location.reload();
      return;
    }
    trackRoute();
    updateBanner();
  }

  function save(analytics) {
    const timestamp = Date.now();
    const next = { version: 1, essential: true, analytics: analytics === true && !gpc(), timestamp, expires: timestamp + MAX_AGE };
    let persisted = false;
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
      persisted = true;
    } catch {
      console.warn("Flight3: privacy choices apply to this document only because storage is unavailable.");
    }
    closePreferences();
    apply(next, { source: "visitor", persisted });
  }

  // Native checkboxes own state; Saddle's decorative cc-active class follows.
  root.addEventListener("change", (event) => {
    const input = event.target;
    if (input instanceof HTMLInputElement) input.closest(".fs-cc-prefs_status-button")?.classList.toggle("cc-active", input.checked);
  });
  document.addEventListener(
    "click",
    (event) => {
      if (!(event.target instanceof Element)) return;
      const button = event.target.closest("[data-consent], [fs-cc]");
      if (!button) return;
      const action = button.getAttribute("data-consent") || button.getAttribute("fs-cc");
      if (action !== "open-preferences" && !root.contains(button)) return;
      if (!["open-preferences", "allow", "deny", "submit", "close"].includes(action)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (action === "open-preferences") openPreferences(button);
      else if (action === "allow") save(true);
      else if (action === "deny") save(false);
      else if (action === "submit") save(analyticsInput.checked);
      else closePreferences(); // Closing is not consent.
    },
    true,
  );
  preferences.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      save(analyticsInput.checked);
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && prefsOpen) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closePreferences();
      }
    },
    true,
  );
  root.querySelectorAll(".fs-cc-prefs_dropdown").forEach((dropdown, index) => {
    const toggle = dropdown.querySelector(".fs-cc-prefs_dropdown-toggle");
    const content = dropdown.querySelector(".fs-cc-prefs_dropdown-content");
    const arrow = dropdown.querySelector(".fs-cc-prefs_dropdown_icon");
    if (!toggle || !content) return;
    enhanceFlight3Button(toggle);
    content.id = `flight3-consent-description-${index}`;
    toggle.setAttribute("aria-controls", content.id);
    toggle.setAttribute("aria-expanded", "false");
    content.hidden = true;
    let tween = null;
    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") !== "true";
      toggle.setAttribute("aria-expanded", String(expanded));
      dropdown.classList.toggle("cc-open", expanded);
      tween?.kill();
      content.hidden = false;
      gsap.set(content, { height: expanded ? 0 : content.getBoundingClientRect().height, overflow: "hidden" });
      tween = animate(content, {
        height: expanded ? "auto" : 0,
        onComplete: () => {
          content.hidden = !expanded;
        },
      });
      if (arrow) animate(arrow, { rotation: expanded ? 90 : 0 });
    });
  });
  window.addEventListener("storage", (event) => {
    if (event.key === KEY || event.key === null) apply(read());
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) apply(read());
  });
  const observer = new MutationObserver(updateBanner);
  observer.observe(html, { attributes: true, attributeFilter: ["class"] });
  window.Flight3Consent = {
    get: () => ({ essential: true, analytics: allowed }),
    openPreferences,
    accept: () => save(true),
    reject: () => save(false),
    ready() {
      ready = true;
      updateBanner();
    },
    beginNavigation() {
      navigating = true;
      closePreferences({ immediate: true, restoreFocus: false });
      updateBanner();
    },
    completeNavigation() {
      const previousURL = route.url;
      route = { url: cleanURL(), title: document.title, referrer: previousURL, token: route.token + 1 };
      navigating = false;
      ready = true;
      if (record && record.expires <= Date.now()) apply(null);
      else {
        trackRoute();
        updateBanner();
      }
    },
    abortNavigation() {
      navigating = false;
      trackRoute();
      updateBanner();
    },
  };
  apply(record);
  return window.Flight3Consent;
}

function initHomeTestimonials({ root, signal, gsap, SplitText }) {
  const wraps = root.querySelectorAll("[data-testimonial-wrap]");
  if (!wraps.length || typeof SplitText === "undefined") return;

  const cleanupTasks = [];
  const imageClipHidden = "circle(0% at 50% 50%)";
  const imageClipVisible = "circle(50% at 50% 50%)";

  wraps.forEach((wrap) => {
    const list = wrap.querySelector("[data-testimonial-list]");
    if (!list) return;

    const items = Array.from(list.querySelectorAll("[data-testimonial-item]"));
    if (!items.length) return;

    const btnPrev = wrap.querySelector("[data-prev]");
    const btnNext = wrap.querySelector("[data-next]");
    const elCurrent = wrap.querySelector("[data-current]");
    const elTotal = wrap.querySelector("[data-total]");
    const controls = [btnPrev, btnNext].filter(Boolean);
    const originalItemAria = new Map(items.map((item) => [item, item.getAttribute("aria-hidden")]));
    const originalControlState = new Map(
      controls.map((control) => [
        control,
        {
          disabled: control.getAttribute("disabled"),
          ariaDisabled: control.getAttribute("aria-disabled"),
        },
      ]),
    );
    const originalCounterLive = elCurrent?.getAttribute("aria-live") ?? null;

    if (elTotal) elTotal.textContent = String(items.length);
    if (elCurrent) elCurrent.setAttribute("aria-live", "polite");

    let activeIndex = items.findIndex((element) => element.classList.contains("is--active"));
    if (activeIndex < 0) activeIndex = 0;

    let isAnimating = false;
    let reduceMotion = false;
    const autoplayEnabled = wrap.getAttribute("data-autoplay") === "true";
    const autoplayDuration = parseInt(wrap.getAttribute("data-autoplay-duration"), 10) || 4000;
    let autoplayCall = null;
    let activeTimeline = null;

    const slides = items.map((item) => ({
      item,
      image: item.querySelector("[data-testimonial-img]"),
      splitTargets: [item.querySelector("[data-testimonial-text]"), ...item.querySelectorAll("[data-testimonial-split]")].filter(Boolean),
      splitInstances: [],
      getLines() {
        return this.splitInstances.flatMap((instance) => instance.lines);
      },
    }));

    function setSlideState(slideIndex, isActive) {
      const { item } = slides[slideIndex];
      item.classList.toggle("is--active", isActive);
      item.setAttribute("aria-hidden", String(!isActive));
      gsap.set(item, {
        autoAlpha: isActive ? 1 : 0,
        pointerEvents: isActive ? "auto" : "none",
      });
    }

    function updateCounter() {
      if (elCurrent) elCurrent.textContent = String(activeIndex + 1);
    }

    function setControlsDisabled(disabled) {
      controls.forEach((control) => {
        if ("disabled" in control) control.disabled = disabled;
        control.setAttribute("aria-disabled", String(disabled));
      });
    }

    function startAutoplay() {
      if (!autoplayEnabled) return;
      autoplayCall?.kill();
      autoplayCall = gsap.delayedCall(autoplayDuration / 1000, () => {
        if (isAnimating) {
          startAutoplay();
          return;
        }
        goTo((activeIndex + 1) % slides.length);
        startAutoplay();
      });
    }

    function resetAutoplay() {
      if (!autoplayEnabled) return;
      startAutoplay();
    }

    slides.forEach((_, index) => setSlideState(index, index === activeIndex));
    updateCounter();

    const media = gsap.matchMedia();
    media.add({ reduce: "(prefers-reduced-motion: reduce)" }, (context) => {
      reduceMotion = context.conditions.reduce;
    });

    slides.forEach((slide, slideIndex) => {
      slide.splitInstances = slide.splitTargets.map((element) =>
        SplitText.create(element, {
          type: "lines",
          mask: "lines",
          linesClass: "text-line",
          autoSplit: true,
          onSplit(self) {
            if (reduceMotion) return;

            const isActive = slideIndex === activeIndex;
            gsap.set(self.lines, { yPercent: isActive ? 0 : 110 });
            if (slide.image) {
              gsap.set(slide.image, {
                clipPath: isActive ? imageClipVisible : imageClipHidden,
              });
            }
          },
        }),
      );
    });

    function goTo(nextIndex) {
      if (isAnimating || nextIndex === activeIndex) return;
      isAnimating = true;
      setControlsDisabled(true);

      const outgoingSlide = slides[activeIndex];
      const incomingSlide = slides[nextIndex];

      activeTimeline = gsap.timeline({
        onComplete: () => {
          setSlideState(activeIndex, false);
          setSlideState(nextIndex, true);
          activeIndex = nextIndex;
          updateCounter();
          isAnimating = false;
          setControlsDisabled(false);
        },
      });

      if (reduceMotion) {
        activeTimeline
          .to(outgoingSlide.item, { autoAlpha: 0, duration: 0.4, ease: "power2" }, 0)
          .fromTo(incomingSlide.item, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.4, ease: "power2" }, 0);
        return;
      }

      const outgoingLines = outgoingSlide.getLines();
      const incomingLines = incomingSlide.getLines();

      gsap.set(incomingSlide.item, {
        autoAlpha: 1,
        pointerEvents: "auto",
      });
      gsap.set(incomingLines, { yPercent: 110 });

      if (outgoingSlide.image) {
        gsap.set(outgoingSlide.image, { clipPath: imageClipVisible });
      }

      activeTimeline.to(
        outgoingLines,
        {
          yPercent: -110,
          duration: 0.6,
          ease: "power4.inOut",
          stagger: { amount: 0.25 },
        },
        0,
      );

      if (outgoingSlide.image) {
        activeTimeline.to(
          outgoingSlide.image,
          {
            clipPath: imageClipHidden,
            duration: 0.6,
            ease: "power4.inOut",
          },
          0,
        );
      }

      activeTimeline.to(
        incomingLines,
        {
          yPercent: 0,
          duration: 0.7,
          ease: "power4.inOut",
          stagger: { amount: 0.4 },
        },
        ">-=0.3",
      );

      if (incomingSlide.image) {
        activeTimeline.fromTo(
          incomingSlide.image,
          { clipPath: imageClipHidden },
          {
            clipPath: imageClipVisible,
            duration: 0.75,
            ease: "power4.inOut",
          },
          "<",
        );
      }

      activeTimeline.set(outgoingSlide.item, { autoAlpha: 0 }, ">");
    }

    startAutoplay();

    btnNext?.addEventListener(
      "click",
      () => {
        resetAutoplay();
        goTo((activeIndex + 1) % slides.length);
      },
      { signal },
    );

    btnPrev?.addEventListener(
      "click",
      () => {
        resetAutoplay();
        goTo((activeIndex - 1 + slides.length) % slides.length);
      },
      { signal },
    );

    cleanupTasks.push(() => {
      autoplayCall?.kill();
      activeTimeline?.kill();
      media.revert();
      slides.forEach((slide) => {
        slide.splitInstances.forEach((instance) => instance.revert());
      });
      gsap.set(items, { clearProps: "opacity,visibility,pointerEvents" });
      originalItemAria.forEach((value, item) => {
        if (value === null) item.removeAttribute("aria-hidden");
        else item.setAttribute("aria-hidden", value);
      });
      originalControlState.forEach((state, control) => {
        if (state.disabled === null) control.removeAttribute("disabled");
        else control.setAttribute("disabled", state.disabled);
        if (state.ariaDisabled === null) control.removeAttribute("aria-disabled");
        else control.setAttribute("aria-disabled", state.ariaDisabled);
      });
      if (elCurrent) {
        if (originalCounterLive === null) elCurrent.removeAttribute("aria-live");
        else elCurrent.setAttribute("aria-live", originalCounterLive);
      }
    });
  });

  return () => cleanupTasks.reverse().forEach((cleanup) => cleanup());
}

function initHomeVideoModal({ root, signal, setScrollLock }) {
  /* The modal may be a sibling of <main> while remaining inside #swup. */
  const scope = root.closest("#swup") || root;
  const videoPlayer = scope.querySelector("#videoplayer");
  const modal = scope.querySelector("#videoModal");
  if (!(videoPlayer instanceof HTMLVideoElement) || !modal) return;

  const openBtn = scope.querySelector('[data-video-modal="open"]');
  enhanceFlight3Button(openBtn, signal);
  const playButton = modal.querySelector('[data-video-control="play"]');
  const muteButton = modal.querySelector('[data-video-control="mute"]');
  const source = videoPlayer.getAttribute("data-video-src") || videoPlayer.getAttribute("src") || "";
  let isOpen = false;
  let lastFocused = null;

  if (source) videoPlayer.setAttribute("data-video-src", source);
  videoPlayer.removeAttribute("src");
  videoPlayer.controls = false;
  videoPlayer.load();
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  if (!modal.hasAttribute("tabindex")) modal.setAttribute("tabindex", "-1");

  const focusTrap = createFlight3FocusTrap(modal, { signal });

  const syncControls = () => {
    const isPlaying = !videoPlayer.paused && !videoPlayer.ended;
    const isMuted = videoPlayer.muted;

    if (playButton) {
      playButton.setAttribute("aria-label", isPlaying ? "Pause video" : "Play video");
      playButton.setAttribute("data-video-state", isPlaying ? "playing" : "paused");
    }

    if (muteButton) {
      muteButton.setAttribute("aria-label", isMuted ? "Unmute video" : "Mute video");
      muteButton.setAttribute("aria-pressed", String(isMuted));
      muteButton.setAttribute("data-video-state", isMuted ? "muted" : "unmuted");
    }
  };

  const stopVideo = () => {
    videoPlayer.pause();
    if (videoPlayer.readyState > HTMLMediaElement.HAVE_NOTHING) {
      videoPlayer.currentTime = 0;
    }
    videoPlayer.removeAttribute("src");
    videoPlayer.load();
    syncControls();
  };

  const playVideo = () => {
    if (!videoPlayer.getAttribute("src") && source) {
      videoPlayer.setAttribute("src", source);
      videoPlayer.load();
    }

    if (videoPlayer.ended) videoPlayer.currentTime = 0;
    const playRequest = videoPlayer.play();
    playRequest?.catch?.(() => syncControls());
  };

  const openModal = (event) => {
    event?.preventDefault();
    if (isOpen) return;

    isOpen = true;
    lastFocused = event?.currentTarget || document.activeElement;
    modal.classList.add("is--open");
    modal.setAttribute("aria-hidden", "false");
    document.documentElement.classList.add("has-video-modal-open");
    document.documentElement.setAttribute("data-video-modal-open", "");
    setScrollLock?.("video-modal", true);
    focusTrap.activate();
    modal.focus({ preventScroll: true });
    playVideo();
  };

  const closeModal = (event, { restoreFocus = true } = {}) => {
    event?.preventDefault();
    isOpen = false;
    stopVideo();

    focusTrap.deactivate();
    modal.classList.remove("is--open");
    modal.setAttribute("aria-hidden", "true");
    document.documentElement.classList.remove("has-video-modal-open");
    document.documentElement.removeAttribute("data-video-modal-open");
    setScrollLock?.("video-modal", false);
    if (restoreFocus) lastFocused?.focus?.({ preventScroll: true });
    lastFocused = null;
  };

  const togglePlayback = (event) => {
    event?.preventDefault();
    event?.stopPropagation();
    if (videoPlayer.paused || videoPlayer.ended) playVideo();
    else videoPlayer.pause();
  };

  const toggleMute = (event) => {
    event?.preventDefault();
    event?.stopPropagation();
    videoPlayer.muted = !videoPlayer.muted;
    syncControls();
  };

  openBtn?.addEventListener("click", openModal, { signal });
  playButton?.addEventListener("click", togglePlayback, { signal });
  muteButton?.addEventListener("click", toggleMute, { signal });
  ["play", "pause", "ended", "volumechange"].forEach((eventName) => {
    videoPlayer.addEventListener(eventName, syncControls, { signal });
  });
  modal.addEventListener(
    "click",
    (event) => {
      const closeControl = event.target.closest?.('[data-video-modal="close"]');
      const clickedBackdrop = event.target.matches?.('[data-video-modal="backdrop"]') || event.target.classList?.contains("modal_content");

      if (closeControl || clickedBackdrop) closeModal(event);
    },
    { signal },
  );
  videoPlayer.addEventListener(
    "error",
    () => {
      if (isOpen) console.warn("Flight3: the modal video could not be loaded.");
      syncControls();
    },
    { signal },
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && modal.getAttribute("aria-hidden") === "false") {
        closeModal();
      }
    },
    { signal },
  );

  syncControls();
  return () => closeModal(null, { restoreFocus: false });
}

function initBackgroundVideos({ root = document, ScrollTrigger = window.ScrollTrigger } = {}) {
  const cards = Array.from(root.querySelectorAll(".home-feat-card, .home-feat_card"));
  if (!cards.length || !ScrollTrigger) return;

  const mobileQuery = window.matchMedia("(max-width: 767px)");
  const entries = [];
  let activeVideo = null;

  const pauseVideo = (video) => {
    if (!video) return;
    video.pause();
    if (activeVideo === video) activeVideo = null;
  };

  const pauseAll = () => {
    entries.forEach(({ video }) => video.pause());
    activeVideo = null;
  };

  const playVideo = (video) => {
    if (!video || mobileQuery.matches) return;

    if (activeVideo && activeVideo !== video) activeVideo.pause();
    if (activeVideo === video && !video.paused) return;

    activeVideo = video;
    video.play().catch(() => {
      if (activeVideo === video) activeVideo = null;
    });
  };

  cards.forEach((card) => {
    const video = card.querySelector("[data-home-feat-video]");
    if (!(video instanceof HTMLVideoElement)) return;

    video.muted = true;
    video.playsInline = true;
    video.setAttribute("muted", "");
    video.setAttribute("playsinline", "");

    const trigger = ScrollTrigger.create({
      trigger: card,
      start: "top 75%",
      end: "bottom 25%",
      onEnter: () => playVideo(video),
      onEnterBack: () => playVideo(video),
      onLeave: () => pauseVideo(video),
      onLeaveBack: () => pauseVideo(video),
    });

    entries.push({ video, trigger });
  });

  if (!entries.length) return;

  const handleMobileChange = (event) => {
    if (event.matches) {
      pauseAll();
      return;
    }

    const activeEntry = entries.find(({ trigger }) => trigger.isActive);
    if (activeEntry) playVideo(activeEntry.video);
  };

  mobileQuery.addEventListener("change", handleMobileChange);
  if (mobileQuery.matches) pauseAll();

  return () => {
    mobileQuery.removeEventListener("change", handleMobileChange);
    entries.forEach(({ trigger }) => trigger.kill());
    pauseAll();
  };
}

function initHomeHero({
  root = document,
  gsap: gsapInstance = window.gsap,
  ScrollTrigger: scrollTriggerInstance = window.ScrollTrigger,
  SplitText: splitTextInstance = window.SplitText,
} = {}) {
  const section = root.querySelector(".section.is--home-hero");
  if (!section || !gsapInstance || !scrollTriggerInstance || !splitTextInstance) {
    return undefined;
  }
  if (section.__homeHeroCleanup) return section.__homeHeroCleanup;

  const gsap = gsapInstance;
  const ScrollTrigger = scrollTriggerInstance;
  const SplitText = splitTextInstance;
  const container = section.querySelector(".container.is--home-hero");
  const firstWrap = section.querySelector(".home-hero_wrap.is--1");
  const secondWrap = section.querySelector(".home-hero_wrap.is--2");
  const heading = section.querySelector(".home-disp");
  const visualAnchor = section.querySelector(".home-disp_vis");
  const ringPath = section.querySelector(".home-hero_ring-path");
  const copy = section.querySelector(".home-hero_copy");
  const backgroundElement = section.querySelector(".home-hero_bg-el");

  if (!container || !firstWrap || !heading || !visualAnchor || !ringPath || !copy) {
    return undefined;
  }

  const cards = gsap.utils.toArray(".home-hero_vis-img", visualAnchor);
  const headingText = gsap.utils.toArray(".home-disp_text, .home-disp_vis-alt", heading);
  if (!cards.length) return undefined;

  gsap.registerPlugin(ScrollTrigger, SplitText);

  const media = gsap.matchMedia();
  const clamp01 = gsap.utils.clamp(0, 1);
  const mix = gsap.utils.interpolate;
  const INITIAL_SLOT_BY_INDEX = [0, 1, 2, 3, 4, 4, 4, 4, 3, 2, 1, 0, 0, 0];
  const PATH_SAMPLE_COUNT = 720;
  const ROTATION_START = 0.06;
  const OPEN_END = 0.3;
  const LOOP_END = 0.72;
  const UNWRAP_CURVE_SAMPLES = 240;
  const LANDING_BLEND_SPAN = 0.24;
  const state = { progress: 0 };
  const layout = {
    pathX: new Float64Array(PATH_SAMPLE_COUNT + 1),
    pathY: new Float64Array(PATH_SAMPLE_COUNT + 1),
  };
  const cardStyles = cards.map((card) => card.style);
  const lastZIndexes = new Array(cards.length).fill(null);
  const unwrapStates = cards.map(() => ({
    centerX: 0,
    centerY: 0,
    size: 0,
    z: 0,
    zIndex: 0,
    x: 0,
    y: 0,
  }));
  const unwrapSourceScratch = {};
  const unwrapLookupLength = UNWRAP_CURVE_SAMPLES + 2;
  const unwrapLookup = {
    x: new Float64Array(unwrapLookupLength),
    y: new Float64Array(unwrapLookupLength),
    size: new Float64Array(unwrapLookupLength),
    z: new Float64Array(unwrapLookupLength),
    zIndex: new Float64Array(unwrapLookupLength),
    distance: new Float64Array(unwrapLookupLength),
  };

  function smootherstep(start, end, value) {
    const progress = clamp01((value - start) / (end - start));
    return progress ** 3 * (progress * (progress * 6 - 15) + 10);
  }

  function wrapDistance(distance) {
    return ((distance % layout.pathLength) + layout.pathLength) % layout.pathLength;
  }

  function ringCoordinates(distance) {
    const tablePosition = (wrapDistance(distance) / layout.pathLength) * PATH_SAMPLE_COUNT;
    const lowerIndex = Math.floor(tablePosition);
    const upperIndex = Math.min(lowerIndex + 1, PATH_SAMPLE_COUNT);
    const amount = tablePosition - lowerIndex;
    const pointX = mix(layout.pathX[lowerIndex], layout.pathX[upperIndex], amount);
    const pointY = mix(layout.pathY[lowerIndex], layout.pathY[upperIndex], amount);
    const bounds = layout.pathBounds;
    const normalizedX = (pointX - bounds.x) / bounds.width;
    const normalizedY = (pointY - bounds.y) / bounds.height;

    return {
      x: layout.ringCenterX + (normalizedX - 0.5) * layout.ringWidth,
      y: layout.ringCenterY + (normalizedY - 0.5) * layout.ringHeight,
      depth: clamp01(normalizedY),
    };
  }

  function measure() {
    const wrapRect = firstWrap.getBoundingClientRect();
    const anchorRect = visualAnchor.getBoundingClientRect();
    const inlineCard = anchorRect.height;
    const inlineGap = Math.max(0, (anchorRect.width - inlineCard * 5) / 4);
    const width = window.innerWidth;
    const height = window.innerHeight;
    const mobile = width < 768;

    layout.width = width;
    layout.height = height;
    layout.inlineCard = inlineCard;
    layout.inlineGap = inlineGap;
    layout.anchorX = anchorRect.left - wrapRect.left;
    layout.anchorY = anchorRect.top - wrapRect.top;
    layout.ringCard = mobile ? Math.min(Math.max(inlineCard * 1.28, 62), 88) : Math.min(Math.max(inlineCard * 1.38, 72), 104);
    layout.ringWidth = mobile ? Math.min(width * 0.82, 340) : Math.min(500, width * 0.72);
    layout.ringHeight = layout.ringWidth * (320 / 500);
    layout.ringCenterX = width * 0.5 - wrapRect.left;
    layout.ringCenterY = height * (mobile ? 0.55 : 0.535);
    const pathSignature = `${ringPath.getAttribute("d")}|${getComputedStyle(ringPath).d}`;
    const pathChanged = layout.pathSignature !== pathSignature;
    if (pathChanged) {
      layout.pathLength = ringPath.getTotalLength();
      layout.pathBounds = ringPath.getBBox();
      layout.pathSignature = pathSignature;
    }

    /* The final strip spans 105vw, so both outside cards crop naturally. */
    layout.lineGap = mobile ? 6 : Math.min(Math.max(width * 0.0065, 8), 16);
    layout.lineOverscan = mobile ? 0 : Math.max(width * 0.025, 24);
    layout.lineCard = mobile
      ? Math.min(Math.max(width * 0.22, 74), 100)
      : (width + layout.lineOverscan * 2 - (cards.length - 1) * layout.lineGap) / cards.length;
    layout.lineWidth = cards.length * layout.lineCard + (cards.length - 1) * layout.lineGap;
    layout.lineStartX = -wrapRect.left - layout.lineOverscan;
    layout.lineStep = layout.lineCard + layout.lineGap;
    layout.lineY = height * (mobile ? 0.59 : 0.545) - layout.lineCard / 2;

    if (pathChanged) {
      let smallestX = Infinity;
      layout.exitDistance = 0;
      for (let sample = 0; sample <= PATH_SAMPLE_COUNT; sample += 1) {
        const distance = (sample / PATH_SAMPLE_COUNT) * layout.pathLength;
        const point = ringPath.getPointAtLength(distance);
        layout.pathX[sample] = point.x;
        layout.pathY[sample] = point.y;
        if (point.x < smallestX) {
          smallestX = point.x;
          layout.exitDistance = distance;
        }
      }
    }

    /* Image 1 reaches image 14's former ring position before unfolding. */
    layout.headDistance = layout.exitDistance - layout.pathLength / cards.length;

    buildUnwrapSourceSamples();
    lastZIndexes.fill(null);

    gsap.set(cards, {
      width: inlineCard,
      height: inlineCard,
      opacity: 1,
      force3D: true,
      willChange: "transform",
    });
  }

  function initialState(index) {
    const visibleSlot = INITIAL_SLOT_BY_INDEX[index] ?? Math.min(index, 4);
    return {
      x: layout.anchorX + visibleSlot * (layout.inlineCard + layout.inlineGap),
      y: layout.anchorY,
      size: layout.inlineCard,
      z: -Math.floor(index / 5) * 3,
      zIndex: index < 5 ? 100 - index : 20 - index,
    };
  }

  function ringStateAtDistance(distance) {
    const point = ringCoordinates(distance);
    const size = layout.ringCard * mix(0.94, 1.12, point.depth);
    return {
      x: point.x - size / 2,
      y: point.y - size / 2,
      size,
      z: mix(-70, 70, point.depth),
      zIndex: Math.round(point.depth * 80) + 20,
    };
  }

  function ringState(index, loopProgress = 0) {
    const trailSpacing = -(index / cards.length) * layout.pathLength;
    const travel = loopProgress * layout.pathLength;
    return ringStateAtDistance(layout.headDistance + trailSpacing + travel);
  }

  function lineState(index) {
    return {
      x: layout.lineStartX + index * layout.lineStep,
      y: layout.lineY,
      size: layout.lineCard,
      z: 0,
      zIndex: 50,
    };
  }

  function interpolateState(from, to, amount) {
    return {
      x: mix(from.x, to.x, amount),
      y: mix(from.y, to.y, amount),
      size: mix(from.size, to.size, amount),
      z: mix(from.z, to.z, amount),
      zIndex: amount < 0.5 ? from.zIndex : to.zIndex,
    };
  }

  function buildUnwrapSourceSamples() {
    const lastIndex = cards.length - 1;
    const lineStart = lineState(0);
    const lineEnd = lineState(lastIndex);
    const lineStartCenterX = lineStart.x + lineStart.size / 2;
    const lineEndCenterX = lineEnd.x + lineEnd.size / 2;
    const lineCenterY = lineStart.y + lineStart.size / 2;

    const samples = Array.from({ length: UNWRAP_CURVE_SAMPLES + 1 }, (_, sample) => {
      const t = sample / UNWRAP_CURVE_SAMPLES;
      const distance = layout.headDistance - t * ((cards.length - 1) / cards.length) * layout.pathLength;
      const ring = ringStateAtDistance(distance);
      return {
        sourceX: ring.x + ring.size / 2,
        sourceY: ring.y + ring.size / 2,
        sourceSize: ring.size,
        sourceZ: ring.z,
        sourceZIndex: ring.zIndex,
      };
    });

    let sourceDistance = 0;
    samples[0].sourceDistance = 0;
    for (let index = 0; index < samples.length - 1; index += 1) {
      const current = samples[index];
      const next = samples[index + 1];
      const deltaX = next.sourceX - current.sourceX;
      const deltaY = next.sourceY - current.sourceY;
      sourceDistance += Math.hypot(deltaX, deltaY);
      next.sourceDistance = sourceDistance;
    }
    layout.unwrapSourceSamples = samples;
    layout.unwrapSourceLength = sourceDistance;
    layout.unwrapTargetStartX = lineStartCenterX;
    layout.unwrapTargetY = lineCenterY;
    layout.unwrapTargetLength = lineEndCenterX - lineStartCenterX;
  }

  function sampleUnwrapSource(distance, output) {
    const samples = layout.unwrapSourceSamples;
    const target = Math.min(Math.max(distance, 0), layout.unwrapSourceLength);
    let low = 0;
    let high = samples.length - 1;

    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (samples[middle].sourceDistance < target) low = middle + 1;
      else high = middle;
    }

    const next = samples[low];
    const previous = samples[Math.max(0, low - 1)];
    const span = next.sourceDistance - previous.sourceDistance;
    const amount = span > 0 ? (target - previous.sourceDistance) / span : 0;

    output.sourceX = mix(previous.sourceX, next.sourceX, amount);
    output.sourceY = mix(previous.sourceY, next.sourceY, amount);
    output.sourceSize = mix(previous.sourceSize, next.sourceSize, amount);
    output.sourceZ = mix(previous.sourceZ, next.sourceZ, amount);
    output.sourceZIndex = amount < 0.5 ? previous.sourceZIndex : next.sourceZIndex;
    return output;
  }

  function sampleLookupAtDistance(lookupCount, totalLength, distance, output) {
    const target = Math.min(Math.max(distance, 0), totalLength);
    let low = 0;
    let high = lookupCount - 1;

    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (unwrapLookup.distance[middle] < target) low = middle + 1;
      else high = middle;
    }

    const previousIndex = Math.max(0, low - 1);
    const span = unwrapLookup.distance[low] - unwrapLookup.distance[previousIndex];
    const amount = span > 0 ? (target - unwrapLookup.distance[previousIndex]) / span : 0;

    output.centerX = mix(unwrapLookup.x[previousIndex], unwrapLookup.x[low], amount);
    output.centerY = mix(unwrapLookup.y[previousIndex], unwrapLookup.y[low], amount);
    output.size = mix(unwrapLookup.size[previousIndex], unwrapLookup.size[low], amount);
    output.z = mix(unwrapLookup.z[previousIndex], unwrapLookup.z[low], amount);
    output.zIndex = amount < 0.5 ? unwrapLookup.zIndex[previousIndex] : unwrapLookup.zIndex[low];
    return output;
  }

  function buildUnwrapStates(unwrapProgress) {
    let lookupCount = 0;
    let totalLength = 0;
    let previousX = 0;
    let previousY = 0;
    // Keep the moving oval and card enlargement proportional to scroll.
    const geometryProgress = unwrapProgress;
    const sourceStart = layout.unwrapSourceSamples[0];
    const strandStartX = mix(sourceStart.sourceX, layout.unwrapTargetStartX, geometryProgress);
    const strandY = mix(sourceStart.sourceY, layout.unwrapTargetY, geometryProgress);
    const releasedLength = layout.unwrapTargetLength * unwrapProgress;
    const contactX = strandStartX + releasedLength;
    const remainingSourceLength = layout.unwrapSourceLength * (1 - unwrapProgress);
    const lineSize = mix(sourceStart.sourceSize, layout.lineCard, geometryProgress);

    function addLookupPoint(centerX, centerY, size, z, zIndex) {
      if (lookupCount > 0) {
        totalLength += Math.hypot(centerX - previousX, centerY - previousY);
      }
      unwrapLookup.x[lookupCount] = centerX;
      unwrapLookup.y[lookupCount] = centerY;
      unwrapLookup.size[lookupCount] = size;
      unwrapLookup.z[lookupCount] = z;
      unwrapLookup.zIndex[lookupCount] = zIndex;
      unwrapLookup.distance[lookupCount] = totalLength;
      previousX = centerX;
      previousY = centerY;
      lookupCount += 1;
    }

    /*
     * Treat the oval as a moving brush barrel. The released strand is laid
     * straight behind it, while the unreleased strand keeps the exact source
     * oval geometry translated to the travelling contact point.
     */
    /* A fixed sample topology prevents cards from stepping when samples are added. */
    // Endpoints describe the straight strand exactly; keep the curved samples.
    const lineSamples = 1;
    for (let index = 0; index <= lineSamples; index += 1) {
      const amount = index / lineSamples;
      addLookupPoint(
        strandStartX + releasedLength * amount,
        strandY,
        lineSize,
        mix(sourceStart.sourceZ, 0, geometryProgress),
        geometryProgress < 0.72 ? sourceStart.sourceZIndex : 50,
      );
    }

    if (remainingSourceLength > 0.001) {
      const curveSamples = UNWRAP_CURVE_SAMPLES;
      for (let index = 1; index <= curveSamples; index += 1) {
        const sourceDistance = (index / curveSamples) * remainingSourceLength;
        const source = sampleUnwrapSource(sourceDistance, unwrapSourceScratch);
        addLookupPoint(
          contactX + source.sourceX - sourceStart.sourceX,
          strandY + source.sourceY - sourceStart.sourceY,
          mix(source.sourceSize, layout.lineCard, geometryProgress),
          mix(source.sourceZ, 0, geometryProgress),
          geometryProgress < 0.72 ? source.sourceZIndex : 50,
        );
      }
    }

    cards.forEach((_, index) => {
      const distance = cards.length > 1 ? (index / (cards.length - 1)) * totalLength : 0;
      const current = sampleLookupAtDistance(lookupCount, totalLength, distance, unwrapStates[index]);
      const targetCenterX = layout.lineStartX + index * layout.lineStep + layout.lineCard / 2;
      const targetCenterY = layout.lineY + layout.lineCard / 2;
      const landingStart = cards.length > 1 ? (index / (cards.length - 1)) * (1 - LANDING_BLEND_SPAN) : 0;
      const landingProgress = smootherstep(landingStart, landingStart + LANDING_BLEND_SPAN, unwrapProgress);

      current.centerX = mix(current.centerX, targetCenterX, landingProgress);
      current.centerY = mix(current.centerY, targetCenterY, landingProgress);
      current.size = mix(current.size, layout.lineCard, landingProgress);
      current.z = mix(current.z, 0, landingProgress);
      current.zIndex = landingProgress < 0.5 ? current.zIndex : 50;
      current.x = current.centerX - current.size / 2;
      current.y = current.centerY - current.size / 2;
    });

    return unwrapStates;
  }

  function setCardTransform(index, cardState) {
    const scale = cardState.size / layout.inlineCard;
    const x = cardState.x + (cardState.size - layout.inlineCard) / 2;
    const y = cardState.y + (cardState.size - layout.inlineCard) / 2;
    const style = cardStyles[index];

    /* Keep the supplied one-write transform composition on the hot path. */
    style.transform = `translate3d(${x.toFixed(3)}px, ${y.toFixed(3)}px, ` + `${cardState.z.toFixed(3)}px) scale(${scale.toFixed(5)})`;

    if (lastZIndexes[index] !== cardState.zIndex) {
      style.zIndex = String(cardState.zIndex);
      lastZIndexes[index] = cardState.zIndex;
    }
  }

  function render() {
    const progress = state.progress;
    const openingProgress = clamp01(progress / OPEN_END);
    const rotationProgress = clamp01((progress - ROTATION_START) / (LOOP_END - ROTATION_START));
    const unwrapProgress = clamp01((progress - LOOP_END) / (1 - LOOP_END));
    const unwrapStates = progress > LOOP_END ? buildUnwrapStates(unwrapProgress) : null;

    cards.forEach((_, index) => {
      let current;
      if (progress <= OPEN_END) {
        current = interpolateState(initialState(index), ringState(index, rotationProgress), openingProgress);
      } else if (progress <= LOOP_END) {
        current = ringState(index, rotationProgress);
      } else {
        current = unwrapStates[index];
      }
      setCardTransform(index, current);
    });
  }

  media.add("(min-width: 768px) and (prefers-reduced-motion: no-preference)", () => {
    state.progress = 0;
    visualAnchor.classList.add("is-animated");
    const copySplit = SplitText.create(copy, {
      type: "words, chars",
      wordsClass: "home-hero_copy-word",
      charsClass: "home-hero_copy-char",
      tag: "span",
      aria: "auto",
      reduceWhiteSpace: true,
    });

    measure();
    gsap.set(copySplit.chars, { opacity: 0 });
    if (backgroundElement) {
      gsap.set(backgroundElement, {
        opacity: 0,
        yPercent: 20,
        filter: "blur(10px)",
        rotation: -34,
        force3D: true,
      });
    }

    const timeline = gsap.timeline({
      defaults: { ease: "none" },
      scrollTrigger: {
        trigger: container,
        start: "top top",
        end: "bottom bottom",
        scrub: true,
        invalidateOnRefresh: true,
        onRefreshInit: measure,
        onRefresh: render,
      },
    });

    timeline
      .to(state, { progress: 1, duration: 1, ease: "none", onUpdate: render }, 0)
      .to(headingText, { opacity: 0, duration: 0.17, ease: "none" }, 0.45)
      .to(
        copySplit.chars,
        {
          opacity: 1,
          duration: 0.27,
          stagger: { each: 0.00125 },
          ease: "none",
        },
        0.55,
      );

    if (backgroundElement) {
      timeline.to(
        backgroundElement,
        {
          opacity: 0.15,
          yPercent: 0,
          filter: "blur(0px)",
          rotation: -18,
          duration: 1,
          ease: "none",
        },
        0.25,
      );
    }

    render();

    return () => {
      timeline.scrollTrigger?.kill();
      timeline.kill();
      copySplit.revert();
      visualAnchor.classList.remove("is-animated");
      gsap.set(cards, { clearProps: "all" });
      gsap.set(headingText, { clearProps: "opacity" });
      gsap.set(copy, { clearProps: "opacity" });
      if (backgroundElement) {
        gsap.set(backgroundElement, {
          clearProps: "filter,opacity,transform",
        });
      }
    };
  });

  media.add("(max-width: 767px) and (prefers-reduced-motion: no-preference)", () => {
    const mobileVisual = section.querySelector(".hero-m_vis");
    const copySplit = SplitText.create(copy, {
      type: "words, chars",
      wordsClass: "home-hero_copy-word",
      charsClass: "home-hero_copy-char",
      tag: "span",
      aria: "auto",
      reduceWhiteSpace: true,
    });
    gsap.set(copySplit.chars, { opacity: 0 });
    if (backgroundElement) {
      gsap.set(backgroundElement, {
        opacity: 0,
        yPercent: 50,
        rotation: -34,
        force3D: true,
      });
    }

    const timeline = gsap.timeline({
      defaults: { ease: "none" },
      scrollTrigger: {
        trigger: container,
        start: "top top",
        end: "bottom bottom",
        scrub: true,
        invalidateOnRefresh: true,
      },
    });

    const mobileVisualTween =
      secondWrap && mobileVisual
        ? gsap.fromTo(
            mobileVisual,
            { xPercent: 0 },
            {
              xPercent: -80,
              ease: "none",
              scrollTrigger: {
                trigger: secondWrap,
                start: "top bottom",
                end: "bottom top",
                scrub: true,
                invalidateOnRefresh: true,
              },
            },
          )
        : null;

    timeline.to(headingText, { opacity: 0, duration: 0.2, ease: "none" }, 0.43).to(
      copySplit.chars,
      {
        opacity: 1,
        duration: 0.28,
        stagger: { each: 0.00125 },
        ease: "none",
      },
      0.56,
    );

    if (backgroundElement) {
      timeline.to(
        backgroundElement,
        {
          opacity: 0.15,
          yPercent: 0,
          rotation: -18,
          duration: 1.5,
          ease: "none",
        },
        0.15,
      );
    }

    return () => {
      timeline.scrollTrigger?.kill();
      mobileVisualTween?.scrollTrigger?.kill();
      timeline.kill();
      mobileVisualTween?.kill();
      copySplit.revert();
      gsap.set(headingText, { clearProps: "opacity" });
      if (mobileVisual) gsap.set(mobileVisual, { clearProps: "transform" });
      if (backgroundElement) {
        gsap.set(backgroundElement, { clearProps: "opacity,transform" });
      }
    };
  });

  const cleanup = () => {
    media.revert();
    delete section.__homeHeroCleanup;
  };

  section.__homeHeroCleanup = cleanup;
  return cleanup;
}

function initInteractiveCollages({ root, signal, gsap }) {
  const roots = root.querySelectorAll("[data-interactive-collage-init]");
  if (!roots.length) return;

  const ACTIVE_SCALE = 1.6;
  const REST_SCALE = 1.1;
  const PUSH_FORCE = 80;
  const DURATION = 0.8;
  const EASE = "elastic.out(1, 0.75)";
  const cleanups = [];

  roots.forEach((collageRoot) => {
    collageRoot._interactiveCollageAbort?.abort();

    const list = collageRoot.querySelector("[data-interactive-collage-list]");
    const items = Array.from(list?.querySelectorAll("[data-interactive-collage-item]") || []);

    if (!list || !items.length) return;

    const visuals = items.map((item) => item.querySelector("[data-interactive-collage-item-inner]") || item);
    const restStates = visuals.map(() => ({ xPercent: 0, yPercent: 0, rotation: 0 }));
    const media = gsap.matchMedia();

    const randomRestState = () => ({
      xPercent: gsap.utils.random(-10, 10),
      yPercent: gsap.utils.random(-10, 10),
      rotation: gsap.utils.random(-15, 15),
    });

    const getColumnCount = () => {
      const columns = getComputedStyle(list).gridTemplateColumns;
      if (columns && columns !== "none") {
        const count = columns.split(/\s+/).filter(Boolean).length;
        if (count > 0) return count;
      }

      const firstTop = items[0]?.offsetTop;
      const firstRowCount = items.findIndex((item) => Math.abs(item.offsetTop - firstTop) > 1);
      return firstRowCount > 0 ? firstRowCount : items.length;
    };

    media.add(
      {
        allowMotion: "(prefers-reduced-motion: no-preference)",
        finePointer: "(hover: hover) and (pointer: fine)",
      },
      (context) => {
        if (!context.conditions.allowMotion) return;

        const controller = new AbortController();
        const collageSignal = controller.signal;
        let currentIndex = -1;
        let pointerX = 0;
        let pointerY = 0;
        let pointerFrame = 0;

        signal.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
        collageRoot._interactiveCollageAbort = controller;

        const animateVisual = (index, vars) => {
          gsap.to(visuals[index], {
            ...vars,
            duration: DURATION,
            ease: EASE,
            overwrite: "auto",
          });
        };

        const assignRestState = (index) => {
          restStates[index] = randomRestState();
          return restStates[index];
        };

        const resetAll = ({ randomize = true } = {}) => {
          currentIndex = -1;
          items.forEach((item, index) => {
            item.removeAttribute("data-interactive-collage-focus");
            const rest = randomize ? assignRestState(index) : restStates[index];
            animateVisual(index, {
              ...rest,
              scale: REST_SCALE,
            });
          });
        };

        const activate = (activeIndex) => {
          if (activeIndex === currentIndex || activeIndex < 0) return;

          if (currentIndex >= 0) assignRestState(currentIndex);
          currentIndex = activeIndex;
          const columns = Math.max(1, getColumnCount());
          const activeColumn = activeIndex % columns;
          const activeRow = Math.floor(activeIndex / columns);

          items.forEach((item, index) => {
            const isActive = index === activeIndex;
            item.toggleAttribute("data-interactive-collage-focus", isActive);

            if (isActive) {
              animateVisual(index, {
                xPercent: 0,
                yPercent: 0,
                rotation: 0,
                scale: ACTIVE_SCALE,
              });
              return;
            }

            const column = index % columns;
            const row = Math.floor(index / columns);
            const deltaX = column - activeColumn;
            const deltaY = row - activeRow;
            const distanceSquared = deltaX * deltaX + deltaY * deltaY;

            animateVisual(index, {
              xPercent: (PUSH_FORCE * deltaX) / distanceSquared,
              yPercent: (PUSH_FORCE * deltaY) / distanceSquared,
              rotation: restStates[index].rotation,
              scale: REST_SCALE,
            });
          });
        };

        const findClosestIndex = () => {
          let closestIndex = -1;
          let closestDistance = Infinity;

          visuals.forEach((visual, index) => {
            const rect = visual.getBoundingClientRect();
            const deltaX = pointerX - (rect.left + rect.width / 2);
            const deltaY = pointerY - (rect.top + rect.height / 2);
            const distance = deltaX * deltaX + deltaY * deltaY;

            if (distance < closestDistance) {
              closestDistance = distance;
              closestIndex = index;
            }
          });

          return closestIndex;
        };

        visuals.forEach((visual, index) => {
          const rest = assignRestState(index);
          gsap.set(visual, {
            ...rest,
            scale: REST_SCALE,
            transformOrigin: "50% 50%",
            willChange: "transform",
          });
        });

        if (context.conditions.finePointer) {
          list.addEventListener(
            "pointermove",
            (event) => {
              pointerX = event.clientX;
              pointerY = event.clientY;
              if (pointerFrame) return;

              pointerFrame = requestAnimationFrame(() => {
                pointerFrame = 0;
                activate(findClosestIndex());
              });
            },
            { signal: collageSignal, passive: true },
          );

          list.addEventListener("pointerleave", () => resetAll(), { signal: collageSignal });
        } else {
          items.forEach((item, index) => {
            item.addEventListener(
              "click",
              (event) => {
                event.stopPropagation();
                if (currentIndex === index) resetAll();
                else activate(index);
              },
              { signal: collageSignal },
            );
          });

          document.addEventListener(
            "click",
            (event) => {
              if (!collageRoot.contains(event.target)) resetAll();
            },
            { signal: collageSignal },
          );
        }

        return () => {
          controller.abort();
          if (pointerFrame) cancelAnimationFrame(pointerFrame);
          if (collageRoot._interactiveCollageAbort === controller) {
            delete collageRoot._interactiveCollageAbort;
          }
          items.forEach((item) => {
            item.removeAttribute("data-interactive-collage-focus");
          });
          visuals.forEach((visual) => {
            gsap.killTweensOf(visual);
            gsap.set(visual, { clearProps: "transform,willChange" });
          });
          currentIndex = -1;
        };
      },
    );

    cleanups.push(() => media.revert());
  });

  return () => cleanups.reverse().forEach((cleanup) => cleanup());
}

const IMAGE_TRAIL_DEFAULTS = Object.freeze({
  movementThreshold: 100,
  delayBetween: 80,
  imageWidth: 180,
  imageHeight: 150,
  entranceDuration: 1,
  exitDuration: 0.5,
  exitDelay: 0.5,
  rotationEnabled: true,
  rotationRange: [-10, 10],
  entranceEase: "back.out(2)",
  exitEase: "power2.in",
  maxActiveImages: 6,
});

let activeImageTrails = [];
let lastImageTrailContext = null;
const imageTrailReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

class Flight3ImageTrail {
  constructor(container, options, gsap) {
    this.container = container;
    this.options = { ...IMAGE_TRAIL_DEFAULTS, ...options };
    this.gsap = gsap;
    this.trailContainer = null;
    this.gallery = null;
    this.images = [];
    this.currentImageIndex = 0;
    this.lastMousePos = { x: 0, y: 0 };
    this.lastImageTime = Date.now();
    this.activeTrails = new Map();
    this.controller = null;
    this.init();
  }

  init() {
    this.trailContainer = this.container.querySelector(".image_trail_container");
    this.gallery = this.container.querySelector(".image_trail_gallery");

    if (!this.trailContainer || !this.gallery) return;

    this.images = Array.from(this.gallery.children);
    if (!this.images.length) return;

    this.bindEvents();
  }

  bindEvents() {
    this.controller?.abort();
    this.controller = new AbortController();
    this.container.addEventListener(
      "mousemove",
      (event) => {
        this.createImageTrail(event);
      },
      { signal: this.controller.signal, passive: true },
    );
  }

  createImageTrail(event) {
    const dx = event.clientX - this.lastMousePos.x;
    const dy = event.clientY - this.lastMousePos.y;
    const distance = Math.hypot(dx, dy);

    if (distance < this.options.movementThreshold) return;

    const now = Date.now();
    if (now - this.lastImageTime < this.options.delayBetween) return;

    if (this.activeTrails.size >= this.options.maxActiveImages) {
      const oldestImage = this.activeTrails.keys().next().value;
      if (oldestImage) {
        this.activeTrails.get(oldestImage)?.kill();
        oldestImage.remove();
        this.activeTrails.delete(oldestImage);
      }
    }

    const sourceImage = this.images[this.currentImageIndex];
    const image = sourceImage.cloneNode(true);
    image.classList.add("image_trail_item");

    this.currentImageIndex = (this.currentImageIndex + 1) % this.images.length;

    const hasNaturalSize = sourceImage.naturalWidth > 0 && sourceImage.naturalHeight > 0;
    const aspectRatio = hasNaturalSize
      ? sourceImage.naturalWidth / sourceImage.naturalHeight
      : this.options.imageWidth / this.options.imageHeight;
    const imageWidth = this.options.imageWidth;
    const imageHeight = imageWidth / aspectRatio;

    this.trailContainer.appendChild(image);
    this.gsap.set(image, {
      position: "fixed",
      top: 0,
      left: 0,
      width: imageWidth,
      height: imageHeight,
      x: event.clientX - imageWidth / 2,
      y: event.clientY - imageHeight / 2,
      force3D: true,
    });

    const rotation = this.options.rotationEnabled
      ? this.gsap.utils.random(this.options.rotationRange[0], this.options.rotationRange[1])
      : 0;
    const entranceLegDuration =
      this.options.exitDelay > 0 ? Math.min(this.options.entranceDuration, this.options.exitDelay) : this.options.entranceDuration;
    const holdDuration = Math.max(0, this.options.exitDelay - this.options.entranceDuration);

    const timeline = this.gsap.timeline({
      onComplete: () => {
        image.remove();
        this.activeTrails.delete(image);
      },
    });
    timeline
      .fromTo(
        image,
        { autoAlpha: 1, scale: 0, rotation },
        {
          autoAlpha: 1,
          scale: 1,
          duration: entranceLegDuration,
          ease: this.options.entranceEase,
        },
      )
      .to(
        image,
        {
          scale: 0,
          duration: this.options.exitDuration,
          ease: this.options.exitEase,
        },
        `>+=${holdDuration}`,
      );

    this.activeTrails.set(image, timeline);

    this.lastMousePos.x = event.clientX;
    this.lastMousePos.y = event.clientY;
    this.lastImageTime = now;
  }

  destroy() {
    this.controller?.abort();
    this.controller = null;

    this.activeTrails.forEach((timeline, image) => {
      timeline.kill();
      image.remove();
    });

    this.activeTrails.clear();
    this.trailContainer = null;
    this.gallery = null;
    this.images = [];
  }
}

function imageTrailDisabled(element) {
  const value = element.dataset.anmDisable;
  if (!value) return false;
  const queries = {
    desktop: "(min-width: 992px)",
    tablet: "(min-width: 768px) and (max-width: 991px)",
    landscape: "(orientation: landscape) and (max-width: 767px)",
    mobile: "(max-width: 479px)",
  };
  return value
    .split(",")
    .map((entry) => entry.trim())
    .some((viewport) => (queries[viewport] ? window.matchMedia(queries[viewport]).matches : false));
}

function imageTrailRotationRange(container) {
  try {
    const range = JSON.parse(container.dataset.anmRotationRange || "null");
    if (Array.isArray(range) && range.length === 2 && range.every((entry) => Number.isFinite(Number(entry)))) {
      return range.map(Number);
    }
  } catch (error) {
    // Invalid optional configuration uses the default range.
  }
  return IMAGE_TRAIL_DEFAULTS.rotationRange;
}

function destroyImageTrail() {
  activeImageTrails.forEach((instance) => instance.destroy());
  activeImageTrails = [];
}

function buildImageTrails(context) {
  destroyImageTrail();
  const { root, gsap } = context;
  const containers = Array.from(root.querySelectorAll("[data-anm-image-trail]"));
  if (!containers.length) return;

  const touch = "ontouchstart" in window || navigator.maxTouchPoints > 0 || window.matchMedia("(hover: none)").matches;
  if (touch || imageTrailReducedMotion.matches) {
    return;
  }

  containers.forEach((container) => {
    if (imageTrailDisabled(container)) return;

    const config = {
      movementThreshold: parseFloat(container.dataset.anmMovementThreshold) || IMAGE_TRAIL_DEFAULTS.movementThreshold,
      delayBetween: parseFloat(container.dataset.anmDelayBetween) || IMAGE_TRAIL_DEFAULTS.delayBetween,
      imageWidth: parseFloat(container.dataset.anmImageWidth) || IMAGE_TRAIL_DEFAULTS.imageWidth,
      imageHeight: parseFloat(container.dataset.anmImageHeight) || IMAGE_TRAIL_DEFAULTS.imageHeight,
      entranceDuration: parseFloat(container.dataset.anmEntranceDuration) || IMAGE_TRAIL_DEFAULTS.entranceDuration,
      exitDuration: parseFloat(container.dataset.anmExitDuration) || IMAGE_TRAIL_DEFAULTS.exitDuration,
      exitDelay: parseFloat(container.dataset.anmExitDelay) || IMAGE_TRAIL_DEFAULTS.exitDelay,
      rotationEnabled: container.dataset.anmRotationEnabled !== "false",
      rotationRange: imageTrailRotationRange(container),
      entranceEase: container.dataset.anmEntranceEase || IMAGE_TRAIL_DEFAULTS.entranceEase,
      exitEase: container.dataset.anmExitEase || IMAGE_TRAIL_DEFAULTS.exitEase,
      maxActiveImages: parseInt(container.dataset.anmMaxActiveImages, 10) || IMAGE_TRAIL_DEFAULTS.maxActiveImages,
    };

    const instance = new Flight3ImageTrail(container, config, gsap);
    if (instance.trailContainer && instance.images.length) {
      activeImageTrails.push(instance);
    } else {
      instance.destroy();
    }
  });
}

function mountImageTrails(context) {
  lastImageTrailContext = context;
  buildImageTrails(context);

  imageTrailReducedMotion.addEventListener(
    "change",
    () => {
      if (lastImageTrailContext === context) buildImageTrails(context);
    },
    { signal: context.signal },
  );

  return () => {
    destroyImageTrail();
    if (lastImageTrailContext === context) lastImageTrailContext = null;
  };
}

window.Anm = window.Anm || {};
window.Anm.ImageTrail = {
  init() {
    if (!activeImageTrails.length && lastImageTrailContext) {
      buildImageTrails(lastImageTrailContext);
    }
  },
  refresh() {
    if (lastImageTrailContext) buildImageTrails(lastImageTrailContext);
  },
  destroy: destroyImageTrail,
};

function initCmsPrevNext({ root }) {
  const SOURCE_SELECTOR = "[r-prevnext-source], [np-articles-source]";
  const pageRoot = root.closest("[data-page]") || root;
  const current = pageRoot.querySelector("[r-prevnext-source] .w--current, [np-articles-source] .w--current");
  if (!current) return;

  const source = current.closest(SOURCE_SELECTOR);
  const currentItem = current.parentElement;
  const itemsList = currentItem?.parentElement;
  if (!source || !currentItem || !itemsList) return;

  const findSiblingLink = (sibling) => sibling?.querySelector?.("a") || null;
  const firstLink = findSiblingLink(itemsList.firstElementChild);
  const lastLink = findSiblingLink(itemsList.lastElementChild);
  const nextLink = findSiblingLink(currentItem.nextElementSibling) || firstLink;
  const previousLink = findSiblingLink(currentItem.previousElementSibling) || lastLink;

  const linkData = (link) => {
    if (!link) return { href: "", title: "", imageSrc: "" };
    const image = link.querySelector("img");
    return {
      href: link.getAttribute("href") || "",
      title: link.innerText || link.textContent || "",
      imageSrc: image?.getAttribute("src") || "",
    };
  };

  const previous = linkData(previousLink);
  const next = linkData(nextLink);
  const bindings = [
    {
      selectors: "[r-prevnext-next-btn], [np-articles-next-btn]",
      attribute: "href",
      value: next.href,
    },
    {
      selectors: "[r-prevnext-next-text], [np-articles-next-text]",
      property: "innerText",
      value: next.title,
    },
    {
      selectors: "[r-prevnext-prev-btn], [np-articles-prev-btn]",
      attribute: "href",
      value: previous.href,
    },
    {
      selectors: "[r-prevnext-prev-text], [np-articles-prev-text]",
      property: "innerText",
      value: previous.title,
    },
    {
      selectors: "[r-prevnext-prev-img], [np-articles-prev-img]",
      attribute: "src",
      value: previous.imageSrc,
    },
    {
      selectors: "[r-prevnext-next-img], [np-articles-next-img]",
      attribute: "src",
      value: next.imageSrc,
    },
  ];

  bindings.forEach(({ selectors, attribute, property, value }) => {
    if (!value) return;
    pageRoot.querySelectorAll(selectors).forEach((element) => {
      if (property) element[property] = value;
      else element.setAttribute(attribute, value);
    });
  });
}

function initCaseStudyReels({ root, signal }) {
  const isAutomaticVideo = (video) => video instanceof HTMLVideoElement && !video.closest("[data-video-player]");
  const mobileQuery = window.matchMedia("(max-width: 767px)");
  const hoverQuery = window.matchMedia("(hover: hover) and (pointer: fine)");
  const groups = Array.from(root.querySelectorAll("[data-cs-reel-group]"));
  const mainReels = Array.from(root.querySelectorAll("[data-cs-main-reel]")).filter(isAutomaticVideo);

  if (!groups.length && !mainReels.length) return;

  const allVideos = Array.from(root.querySelectorAll("[data-cs-reel], [data-cs-main-reel]")).filter(isAutomaticVideo);
  let reelObserver = null;
  let mainReelObserver = null;
  let runController = null;
  let disposed = false;

  const playback = new WeakMap();

  const prepareVideo = (video) => {
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.playsInline = true;
    video.controls = false;
  };

  const pauseVideo = (video) => {
    const state = video && playback.get(video);
    if (state) {
      state.wanted = false;
      state.request += 1;
    }
    video?.pause();
  };

  const playVideo = async (video) => {
    if (!video || disposed) return false;
    let state = playback.get(video);
    if (!state) {
      state = { wanted: false, pending: null, request: 0, pendingRequest: 0 };
      playback.set(video, state);
    }
    state.wanted = true;
    if (state.pending && state.pendingRequest === state.request) return state.pending;
    if (!video.paused) return true;
    const request = ++state.request;
    state.pendingRequest = request;

    state.pending = (async () => {
      try {
        await video.play();
        if (disposed || !state.wanted) {
          video.pause();
          return false;
        }
        if (request !== state.request) return false;
        if (video.controls) video.controls = false;
        return true;
      } catch (error) {
        if (request === state.request && error.name !== "AbortError" && mobileQuery.matches && !disposed && state.wanted) {
          video.controls = true;
          video.removeAttribute("aria-hidden");
        }
        return false;
      } finally {
        if (state.pendingRequest === request) state.pending = null;
      }
    })();
    return state.pending;
  };

  const showFirstFrame = (video, runSignal) => {
    if (!mobileQuery.matches) return;

    const setFirstFrame = () => {
      if (video.readyState < HTMLMediaElement.HAVE_METADATA) return;
      try {
        video.currentTime = 0.001;
      } catch (error) {
        // Some streaming sources cannot seek until more data is available.
      }
    };

    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      setFirstFrame();
    } else {
      video.addEventListener("loadedmetadata", setFirstFrame, {
        once: true,
        signal: runSignal,
      });
    }
  };

  const disconnectObservers = () => {
    reelObserver?.disconnect();
    mainReelObserver?.disconnect();
    reelObserver = null;
    mainReelObserver = null;
  };

  const initGroupedReels = (runSignal) => {
    const groupEntries = groups
      .map((group) => ({
        videos: Array.from(group.querySelectorAll("[data-cs-reel]")).filter(isAutomaticVideo),
      }))
      .filter(({ videos }) => videos.length);

    groupEntries.forEach(({ videos }) => {
      videos.forEach((video) => {
        prepareVideo(video);
        pauseVideo(video);
        if (mobileQuery.matches) showFirstFrame(video, runSignal);
      });
    });

    if (!groupEntries.length) return;

    if (hoverQuery.matches && !mobileQuery.matches) {
      groupEntries.forEach(({ videos }) => {
        let activeVideo = null;

        videos.forEach((video) => {
          const handleEnter = () => {
            if (activeVideo && activeVideo !== video) pauseVideo(activeVideo);
            activeVideo = video;
            playVideo(video);
          };
          const handleLeave = () => {
            if (activeVideo !== video) return;
            pauseVideo(video);
            activeVideo = null;
          };

          video.addEventListener("mouseenter", handleEnter, {
            signal: runSignal,
          });
          video.addEventListener("mouseleave", handleLeave, {
            signal: runSignal,
          });
        });
      });
      return;
    }

    if (typeof IntersectionObserver === "undefined") return;

    const visibility = new Map();
    groupEntries.forEach(({ videos }) => {
      videos.forEach((video) => visibility.set(video, 0));
    });

    reelObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          visibility.set(entry.target, entry.isIntersecting ? entry.intersectionRatio : 0);
        });

        groupEntries.forEach(({ videos }) => {
          const active = videos
            .map((video) => ({ video, ratio: visibility.get(video) || 0 }))
            .filter(({ ratio }) => ratio >= 0.5)
            .sort((a, b) => b.ratio - a.ratio)[0]?.video;

          videos.forEach((video) => {
            if (video === active) playVideo(video);
            else pauseVideo(video);
          });
        });
      },
      { threshold: [0, 0.5, 0.6, 0.75, 1] },
    );

    groupEntries.forEach(({ videos }) => {
      videos.forEach((video) => reelObserver.observe(video));
    });
  };

  const initMainReels = (runSignal) => {
    if (!mainReels.length) return;

    mainReels.forEach((video) => {
      prepareVideo(video);
      if (mobileQuery.matches) showFirstFrame(video, runSignal);
    });

    if (typeof IntersectionObserver === "undefined") return;

    mainReelObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const video = entry.target;
          if (entry.isIntersecting) {
            playVideo(video);
          } else {
            pauseVideo(video);
            if (mobileQuery.matches) showFirstFrame(video, runSignal);
          }
        });
      },
      {
        rootMargin: "-25% 0px -25% 0px",
        threshold: 0,
      },
    );

    mainReels.forEach((video) => mainReelObserver.observe(video));
  };

  const init = () => {
    runController?.abort();
    disconnectObservers();
    allVideos.forEach(pauseVideo);

    runController = new AbortController();
    initGroupedReels(runController.signal);
    initMainReels(runController.signal);
  };

  init();
  mobileQuery.addEventListener("change", init, { signal });
  hoverQuery.addEventListener("change", init, { signal });

  return () => {
    disposed = true;
    runController?.abort();
    disconnectObservers();
    allVideos.forEach(pauseVideo);
  };
}

function initCaseStudyVideoPlayers({ root, signal }) {
  const players = Array.from(root.querySelectorAll("[data-video-player]")).filter((player) => !player.closest("#videoModal"));
  if (!players.length) return;

  const cleanupTasks = [];

  players.forEach((player) => {
    const videoPlayer = player.querySelector("#videoplayer, video");
    if (!(videoPlayer instanceof HTMLVideoElement)) return;

    const playButton = player.querySelector('[data-video-control="play"]');
    const muteButton = player.querySelector('[data-video-control="mute"]');
    const source = videoPlayer.getAttribute("data-video-src") || videoPlayer.getAttribute("src") || "";
    const hadSource = videoPlayer.hasAttribute("src");

    if (source) videoPlayer.setAttribute("data-video-src", source);
    videoPlayer.controls = false;
    videoPlayer.playsInline = true;

    const syncControls = () => {
      const isPlaying = !videoPlayer.paused && !videoPlayer.ended;
      const isMuted = videoPlayer.muted;

      if (playButton) {
        playButton.setAttribute("aria-label", isPlaying ? "Pause video" : "Play video");
        playButton.setAttribute("data-video-state", isPlaying ? "playing" : "paused");
      }

      if (muteButton) {
        muteButton.setAttribute("aria-label", isMuted ? "Unmute video" : "Mute video");
        muteButton.setAttribute("aria-pressed", String(isMuted));
        muteButton.setAttribute("data-video-state", isMuted ? "muted" : "unmuted");
      }
    };

    const playVideo = () => {
      if (!videoPlayer.getAttribute("src") && source) {
        videoPlayer.setAttribute("src", source);
        videoPlayer.load();
      }

      if (videoPlayer.ended) videoPlayer.currentTime = 0;
      const playRequest = videoPlayer.play();
      playRequest?.catch?.(() => syncControls());
    };

    const togglePlayback = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (videoPlayer.paused || videoPlayer.ended) playVideo();
      else videoPlayer.pause();
    };

    const toggleMute = (event) => {
      event.preventDefault();
      event.stopPropagation();
      videoPlayer.muted = !videoPlayer.muted;
      syncControls();
    };

    playButton?.addEventListener("click", togglePlayback, { signal });
    muteButton?.addEventListener("click", toggleMute, { signal });
    ["play", "pause", "ended", "volumechange"].forEach((eventName) => {
      videoPlayer.addEventListener(eventName, syncControls, { signal });
    });
    videoPlayer.addEventListener("error", syncControls, { signal });

    syncControls();
    cleanupTasks.push(() => {
      videoPlayer.pause();
      if (!hadSource && videoPlayer.hasAttribute("src")) {
        videoPlayer.removeAttribute("src");
        videoPlayer.load();
      }
    });
  });

  if (!cleanupTasks.length) return;
  return () => cleanupTasks.reverse().forEach((cleanup) => cleanup());
}

function initFilterBasic({ root = document, signal } = {}) {
  const groups = Array.from(root.querySelectorAll("[data-filter-group]"));
  if (!groups.length) return;

  const cleanupTasks = [];

  groups.forEach((group) => {
    const buttons = Array.from(group.querySelectorAll("[data-filter-target]"));
    const items = Array.from(group.querySelectorAll("[data-filter-name]"));
    const transitionDelay = 300;
    let transitionTimer = 0;
    let refreshFrame = 0;

    if (!buttons.length || !items.length) return;

    const updateStatus = (element, shouldBeActive) => {
      element.setAttribute("data-filter-status", shouldBeActive ? "active" : "not-active");
      element.setAttribute("aria-hidden", shouldBeActive ? "false" : "true");
    };

    const handleFilter = (target) => {
      window.clearTimeout(transitionTimer);
      window.cancelAnimationFrame(refreshFrame);

      items.forEach((item) => {
        if (item.getAttribute("data-filter-status") === "active") {
          item.setAttribute("data-filter-status", "transition-out");
        }
      });

      buttons.forEach((button) => {
        const isActive = button.getAttribute("data-filter-target") === target;
        button.setAttribute("data-filter-status", isActive ? "active" : "not-active");
        button.setAttribute("aria-pressed", String(isActive));
      });

      transitionTimer = window.setTimeout(() => {
        items.forEach((item) => {
          const shouldBeActive = target === "all" || item.getAttribute("data-filter-name") === target;
          updateStatus(item, shouldBeActive);
        });

        refreshFrame = window.requestAnimationFrame(() => {
          window.Flight3?.refresh?.();
        });
      }, transitionDelay);
    };

    buttons.forEach((button) => {
      enhanceFlight3Button(button, signal);
      button.addEventListener(
        "click",
        () => {
          if (button.getAttribute("data-filter-status") === "active") return;
          handleFilter(button.getAttribute("data-filter-target"));
        },
        { signal },
      );
    });

    cleanupTasks.push(() => {
      window.clearTimeout(transitionTimer);
      window.cancelAnimationFrame(refreshFrame);
    });
  });

  if (!cleanupTasks.length) return;
  return () => cleanupTasks.reverse().forEach((cleanup) => cleanup());
}

const flight3PreviousTestimonials = new Map();
const flight3PersistentTestimonials = new WeakMap();

function initRandomTestimonials({ root }) {
  const scope = root.closest("#swup") || root;
  const cleanupTasks = [];

  const lists = Array.from(document.querySelectorAll(".testimonial-lines_list-alt")).filter((list) => {
    const container = list.closest("#swup");
    return !container || container === scope;
  });

  lists.forEach((list) => {
    const items = Array.from(list.children);
    if (!items.length) return;
    const isPersistent = !list.closest("#swup");

    const identities = items.map((item) =>
      JSON.stringify([
        item.textContent.replace(/\s+/g, " ").trim(),
        item.querySelector("img")?.getAttribute("src") || "",
        item.querySelector("a[href]")?.getAttribute("href") || "",
      ]),
    );
    const historyKey = list.getAttribute("data-testimonial-key") || JSON.stringify(identities);
    const previous = isPersistent ? flight3PersistentTestimonials.get(list) : flight3PreviousTestimonials.get(historyKey);
    const candidates = items
      .map((_, index) => index)
      .filter((index) => (isPersistent ? index !== previous : identities[index] !== previous));
    const pool = candidates.length ? candidates : items.map((_, index) => index);
    const selected = pool[Math.floor(Math.random() * pool.length)];
    if (isPersistent) flight3PersistentTestimonials.set(list, selected);
    else {
      flight3PreviousTestimonials.delete(historyKey);
      flight3PreviousTestimonials.set(historyKey, identities[selected]);
      if (flight3PreviousTestimonials.size > 40) {
        flight3PreviousTestimonials.delete(flight3PreviousTestimonials.keys().next().value);
      }
    }

    items.forEach((item, index) => {
      const display = item.style.getPropertyValue("display");
      const priority = item.style.getPropertyPriority("display");
      if (index === selected) item.style.removeProperty("display");
      else item.style.setProperty("display", "none");

      // Persistent collections retain their selection throughout page teardown.
      if (!isPersistent) {
        cleanupTasks.push(() => {
          if (display) item.style.setProperty("display", display, priority);
          else item.style.removeProperty("display");
        });
      }
    });
  });

  return () => cleanupTasks.reverse().forEach((cleanup) => cleanup());
}

window.Flight3Pages = {
  /* Shared modules: directional hover, interactive collage and image trail. */
  shared(context) {
    const { root, signal } = context;
    const cleanupTasks = runFlight3Initializers(context, [initRandomTestimonials, initInteractiveCollages, mountImageTrails]);
    const containers = root.querySelectorAll("[data-directional-hover]");

    const directionMap = {
      top: "translateY(-100%)",
      bottom: "translateY(100%)",
      left: "translateX(-100%)",
      right: "translateX(100%)",
    };
    const touched = [];

    function getDirection(event, element, type) {
      const { left, top, width, height } = element.getBoundingClientRect();
      const x = event.clientX - left;
      const y = event.clientY - top;

      if (type === "y") return y < height / 2 ? "top" : "bottom";
      if (type === "x") return x < width / 2 ? "left" : "right";

      const distances = {
        top: y,
        right: width - x,
        bottom: height - y,
        left: x,
      };

      return Object.entries(distances).reduce((closest, entry) => (closest[1] < entry[1] ? closest : entry))[0];
    }

    containers.forEach((container) => {
      const type = container.getAttribute("data-type") || "all";

      container.querySelectorAll("[data-directional-hover-item]").forEach((item) => {
        const tile = item.querySelector("[data-directional-hover-tile]");
        if (!tile) return;
        touched.push({ item, tile });

        item.addEventListener(
          "mouseenter",
          (event) => {
            const direction = getDirection(event, item, type);
            tile.style.transition = "none";
            tile.style.transform = directionMap[direction] || "translate(0, 0)";

            // Intentional single reflow: positions the tile on the entry edge
            // before restoring the authored transition.
            void tile.offsetHeight;
            tile.style.transition = "";
            tile.style.transform = "translate(0%, 0%)";
            item.setAttribute("data-status", `enter-${direction}`);
          },
          { signal },
        );

        item.addEventListener(
          "mouseleave",
          (event) => {
            const direction = getDirection(event, item, type);
            item.setAttribute("data-status", `leave-${direction}`);
            tile.style.transform = directionMap[direction] || "translate(0, 0)";
          },
          { signal },
        );
      });
    });

    return () => {
      touched.forEach(({ item, tile }) => {
        item.removeAttribute("data-status");
        tile.style.removeProperty("transition");
        tile.style.removeProperty("transform");
      });
      cleanupTasks.reverse().forEach((cleanup) => cleanup());
    };
  },

  home(context) {
    const cleanupTasks = runFlight3Initializers(context, [initHomeTestimonials, initHomeHero, initHomeVideoModal, initBackgroundVideos]);

    return () => {
      cleanupTasks.reverse().forEach((cleanup) => cleanup());
    };
  },

  insights: initFilterBasic,
  "insight-detail": initCmsPrevNext,
  "case-study"(context) {
    const cleanupTasks = runFlight3Initializers(context, [initCmsPrevNext, initCaseStudyReels, initCaseStudyVideoPlayers]);

    return () => {
      cleanupTasks.reverse().forEach((cleanup) => cleanup());
    };
  },

  /* Services-only module: statement crossfade and circular gallery. */
  services({ root, signal, gsap, ScrollTrigger }) {
    const galleries = Array.from(root.querySelectorAll(".section.is--serv-scroll"));
    const section = galleries[0];
    if (!section) return;

    const cleanupTasks = [];
    const statement = root.querySelector(".serv-statement_wrap");
    const incoming = root.querySelectorAll(".serv-statement_wrap-alt > div");

    if (statement && incoming.length) {
      const statementMedia = gsap.matchMedia();
      statementMedia.add("(prefers-reduced-motion: no-preference)", () => {
        const statementTimeline = gsap
          .timeline({
            scrollTrigger: {
              trigger: section,
              start: "40% 80%",
              end: "45% top",
              scrub: true,
            },
          })
          .fromTo(incoming, { opacity: 0 }, { opacity: 1, ease: "none", stagger: 0.15 }, 0)
          .to(statement, { opacity: 0.3, ease: "none" }, 0);

        return () => {
          statementTimeline.scrollTrigger?.kill();
          statementTimeline.kill();
        };
      });
      cleanupTasks.push(() => statementMedia.revert());
    }

    const CONFIG = {
      idleRotationSpeed: 0.1,
      scrollAcceleration: 0.01,
      maxRotationSpeed: 2.5,
      speedEasing: 0.05,
    };

    galleries.forEach((gallery) => {
      const ring = gallery.querySelector(".circular-gallery_ring");
      if (!ring) return;

      const items = Array.from(ring.children).filter((child) => child.classList.contains("circular-gallery_item"));
      if (!items.length) return;

      const setters = items.map((item) => ({
        x: gsap.quickSetter(item, "x", "px"),
        y: gsap.quickSetter(item, "y", "px"),
      }));

      let ringRotation = 0;
      let rotationDirection = 1;
      let rotationSpeed = CONFIG.idleRotationSpeed;
      let lastTickTime = gsap.ticker.time;
      let tickerActive = false;
      let ringSize = 0;
      let itemSize = 0;
      let radius = 0;

      function measure() {
        ringSize = ring.clientWidth;
        itemSize = items[0].offsetWidth;
        radius = Math.max(0, (ringSize - itemSize) / 2);
      }

      function positionItems() {
        const centerOffset = (ringSize - itemSize) / 2;
        const rotationRadians = (ringRotation * Math.PI) / 180;

        items.forEach((item, index) => {
          const itemAngle = (index / items.length) * Math.PI * 2;
          const angle = itemAngle + rotationRadians;
          setters[index].x(centerOffset + Math.cos(angle) * radius);
          setters[index].y(centerOffset + Math.sin(angle) * radius);
        });
      }

      function tick(time) {
        const deltaFrames = Math.min((time - lastTickTime) * 60, 3);
        lastTickTime = time;
        rotationSpeed += (CONFIG.idleRotationSpeed - rotationSpeed) * CONFIG.speedEasing * deltaFrames;
        ringRotation += rotationSpeed * rotationDirection * deltaFrames;
        positionItems();
      }

      function startTicker() {
        if (tickerActive) return;
        tickerActive = true;
        lastTickTime = gsap.ticker.time;
        gsap.ticker.add(tick);
      }

      function stopTicker() {
        if (!tickerActive) return;
        tickerActive = false;
        gsap.ticker.remove(tick);
      }

      const media = gsap.matchMedia();
      media.add(
        {
          allowMotion: "(prefers-reduced-motion: no-preference)",
          reduceMotion: "(prefers-reduced-motion: reduce)",
        },
        (context) => {
          measure();
          positionItems();
          if (context.conditions.reduceMotion) return;

          const scrollTrigger = ScrollTrigger.create({
            trigger: gallery,
            start: "top bottom",
            end: "bottom top",
            invalidateOnRefresh: true,
            onToggle: (self) => {
              if (self.isActive) startTicker();
              else stopTicker();
            },
            onUpdate: (self) => {
              const velocity = self.getVelocity();
              if (Math.abs(velocity) < 1) return;

              rotationDirection = velocity > 0 ? 1 : -1;
              rotationSpeed = Math.min(rotationSpeed + Math.abs(velocity) * (CONFIG.scrollAcceleration / 60), CONFIG.maxRotationSpeed);
            },
            onRefresh: () => {
              measure();
              positionItems();
            },
          });

          if (scrollTrigger.isActive) startTicker();

          return () => {
            stopTicker();
            scrollTrigger.kill();
          };
        },
      );

      const refreshWhenReady = () => {
        if (signal.aborted) return;
        window.clearTimeout(refreshTimer);
        refreshTimer = window.setTimeout(() => {
          if (!signal.aborted) window.Flight3?.refresh?.();
        }, 80);
      };
      let refreshTimer = 0;
      const images = Array.from(gallery.querySelectorAll("img"));
      const pendingImages = images.filter((image) => !image.complete);

      pendingImages.forEach((image) => {
        image.addEventListener("load", refreshWhenReady, {
          once: true,
          signal,
        });
        image.addEventListener("error", refreshWhenReady, {
          once: true,
          signal,
        });
      });

      document.fonts?.ready?.then(refreshWhenReady);

      cleanupTasks.push(() => {
        window.clearTimeout(refreshTimer);
        media.revert();
        gsap.set(items, { clearProps: "transform" });
      });
    });

    return () => {
      cleanupTasks.reverse().forEach((cleanup) => cleanup());
    };
  },

  /* Work-only module: image-to-background zoom sequence. */
  work({ root, signal, gsap, ScrollTrigger }) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const Flip = window.Flip;
    const containers = Array.from(root.querySelectorAll("[data-bg-zoom-init]"));
    if (!containers.length || !Flip) return;

    let masterTimeline = null;
    let resizeTimer = 0;
    let lastViewportWidth = window.innerWidth;
    let mobileStylesApplied = false;
    let videoVisibilityTriggers = [];
    const originalStyles = new Map();

    containers.forEach((container) => {
      [
        container.querySelector("[data-bg-zoom-content]"),
        container.querySelector("[data-bg-zoom-dark]"),
        container.querySelector("[data-bg-zoom-img]"),
      ]
        .filter(Boolean)
        .forEach((element) => {
          if (!originalStyles.has(element)) {
            originalStyles.set(element, element.getAttribute("style"));
          }
        });
    });

    const getScrollRange = ({ trigger, start, endTrigger, end }) => {
      const scrollTrigger = ScrollTrigger.create({
        trigger,
        start,
        endTrigger,
        end,
      });
      const range = Math.max(1, scrollTrigger.end - scrollTrigger.start);
      scrollTrigger.kill();
      return range;
    };

    const ownedWorkVideos = new Set();
    const killMasterTimeline = () => {
      videoVisibilityTriggers.forEach((trigger) => trigger.kill());
      videoVisibilityTriggers = [];
      masterTimeline?.scrollTrigger?.kill();
      masterTimeline?.kill();
      masterTimeline = null;
    };

    const restoreOriginalStyles = () => {
      originalStyles.forEach((style, element) => {
        if (style === null) element.removeAttribute("style");
        else element.setAttribute("style", style);
      });
    };

    const bgZoomTimeline = ({ refresh = true } = {}) => {
      killMasterTimeline();

      /* The mobile build writes fixed base dimensions so Flip can animate
         solely with transforms. Restore authored styles before rebuilding or
         when crossing back to the desktop implementation. */
      if (mobileStylesApplied) {
        restoreOriginalStyles();
        mobileStylesApplied = false;
      }

      const isMobile = window.matchMedia("(max-width: 767px)").matches;

      masterTimeline = gsap.timeline({
        defaults: { ease: "none" },
        scrollTrigger: {
          trigger: containers[0].querySelector("[data-bg-zoom-start]") || containers[0],
          start: "clamp(top bottom)",
          endTrigger: containers[containers.length - 1],
          end: "bottom top",
          scrub: isMobile ? 0.2 : true,
          invalidateOnRefresh: true,
        },
      });

      containers.forEach((container) => {
        const startEl = container.querySelector("[data-bg-zoom-start]");
        const endEl = container.querySelector("[data-bg-zoom-end]");
        const contentEl = container.querySelector("[data-bg-zoom-content]");
        const darkEl = container.querySelector("[data-bg-zoom-dark]");
        const imgEl = container.querySelector("[data-bg-zoom-img]");
        if (!startEl || !endEl || !contentEl) return;

        const startBounds = isMobile ? startEl.getBoundingClientRect() : null;
        const endBounds = isMobile ? endEl.getBoundingClientRect() : null;
        const startRadius = getComputedStyle(startEl).borderRadius;
        const endRadius = getComputedStyle(endEl).borderRadius;
        const hasRadius = startRadius !== "0px" || endRadius !== "0px";
        contentEl.style.overflow = hasRadius ? "hidden" : "";
        if (hasRadius) {
          gsap.set(contentEl, {
            borderRadius: isMobile ? endRadius : startRadius,
          });
        }

        const zoomScrollRange = getScrollRange({
          trigger: startEl,
          start: "clamp(top bottom)",
          endTrigger: endEl,
          end: "center center",
        });

        const afterScrollRange = getScrollRange({
          trigger: endEl,
          start: "center center",
          endTrigger: container,
          end: "bottom top",
        });

        if (isMobile && startBounds && endBounds) {
          /* Size the layer to its final frame once, then reveal it through a
             moving clip window. The video's object-fit crop stays correctly
             proportioned because the video itself is never scaleX/scaleY
             distorted. */
          Flip.fit(contentEl, endEl, { scale: false });

          const finalX = parseFloat(gsap.getProperty(contentEl, "x")) || 0;
          const finalY = parseFloat(gsap.getProperty(contentEl, "y")) || 0;
          const verticalOffset = Math.min(0, startBounds.top - endBounds.top);
          const insetLeft = Math.max(0, startBounds.left - endBounds.left);
          const insetTop = Math.max(0, startBounds.top - (endBounds.top + verticalOffset));
          const insetRight = Math.max(0, endBounds.width - insetLeft - startBounds.width);
          const insetBottom = Math.max(0, endBounds.height - insetTop - startBounds.height);
          const initialClip = `inset(${insetTop}px ${insetRight}px ${insetBottom}px ${insetLeft}px round ${startRadius})`;
          const finalClip = `inset(0px 0px 0px 0px round ${endRadius})`;

          gsap.set(contentEl, {
            x: finalX,
            y: finalY + verticalOffset,
            clipPath: initialClip,
            willChange: "transform, clip-path",
            backfaceVisibility: "hidden",
            contain: "paint",
            force3D: true,
          });
          mobileStylesApplied = true;

          masterTimeline.to(contentEl, {
            y: finalY,
            clipPath: finalClip,
            duration: zoomScrollRange,
          });
        } else {
          Flip.fit(contentEl, startEl, { scale: false });
          masterTimeline.add(
            Flip.fit(contentEl, endEl, {
              duration: zoomScrollRange,
              ease: "none",
              scale: false,
            }),
          );

          if (hasRadius) {
            masterTimeline.to(contentEl, { borderRadius: endRadius, duration: zoomScrollRange }, "<");
          }
        }

        if (isMobile) {
          /* Do not counter-translate against native mobile scrolling. That
             transform competes with the browser's asynchronous scroll layer
             and jitters as the section exits. Keep an empty timing phase so
             the overlay and media-scale choreography remains unchanged. */
          masterTimeline.to({}, { duration: afterScrollRange });
        } else {
          masterTimeline.to(contentEl, {
            y: `+=${afterScrollRange}`,
            duration: afterScrollRange,
          });
        }

        if (darkEl) {
          gsap.set(darkEl, { opacity: 0 });
          masterTimeline.to(darkEl, { opacity: 0.75, duration: afterScrollRange * 0.25 }, "<");
        }

        if (imgEl) {
          gsap.set(imgEl, {
            scale: 1,
            transformOrigin: "50% 50%",
            ...(isMobile
              ? {
                  willChange: "transform",
                  backfaceVisibility: "hidden",
                  force3D: true,
                }
              : {}),
          });
          masterTimeline.to(
            imgEl,
            {
              scale: 1.25,
              yPercent: -10,
              duration: afterScrollRange,
            },
            "<",
          );

          const video = imgEl instanceof HTMLVideoElement ? imgEl : imgEl.querySelector?.("video");
          if (video) ownedWorkVideos.add(video);

          if (isMobile && video) {
            const playbackTrigger = ScrollTrigger.create({
              trigger: container,
              start: "top bottom",
              end: "bottom top",
              onToggle(self) {
                if (self.isActive) {
                  video.play().catch(() => undefined);
                } else {
                  video.pause();
                }
              },
            });

            videoVisibilityTriggers.push(playbackTrigger);
            if (!playbackTrigger.isActive) video.pause();
          }
        }
      });

      if (refresh) ScrollTrigger.refresh();
    };

    /* mountPage() performs one shared refresh after every page module has
       mounted, so the initial build does not need its own full refresh. */
    bgZoomTimeline({ refresh: false });

    window.addEventListener(
      "resize",
      () => {
        const nextViewportWidth = window.innerWidth;
        const widthChanged = Math.abs(nextViewportWidth - lastViewportWidth) > 1;
        lastViewportWidth = nextViewportWidth;

        /* Mobile browser chrome changes height during scroll. Do not rebuild
           the Flip timeline unless the layout width actually changed. */
        if (!widthChanged && navigator.maxTouchPoints > 0) return;

        window.clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(bgZoomTimeline, 100);
      },
      { signal },
    );

    return () => {
      window.clearTimeout(resizeTimer);
      ownedWorkVideos.forEach((video) => video.pause());
      killMasterTimeline();
      restoreOriginalStyles();
    };
  },
};

/* Flight3 page transitions — Swup controller v1.25.1 */
(() => {
  "use strict";

  const VERSION = "1.25.1";

  const CONFIG = Object.freeze({
    introKey: "flight3-intro-session-complete",
    introLottieDuration: 3.2,
    introExitDuration: 1.15,
    routerSelector: "#swup",
    pageSelector: "[data-transition-page]",
    navSelector: "[data-transition-nav]",
    shadeSelector: "[data-transition-shade]",
    transitionDuration: 1.5,
    heroStart: 0.825,
    pageScale: 0.95,
    pageTravel: "-10rem",
    navExitY: -42,
    navEnterY: 42,
  });

  const NON_HTML_EXTENSION =
    /\.(?:7z|avi|avif|css|csv|docx?|gif|gz|ico|jpe?g|js|json|m4a|mov|mp3|mp4|mpeg|pdf|png|pptx?|rar|svg|tar|tiff?|txt|wav|webm|webp|xlsx?|xml|zip)$/i;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");

  /*
   * Keep the transition surface self-contained. Webflow page CSS remains
   * inside #swup, but the router shell must exist before the first click.
   */
  function ensureTransitionStyles() {
    if (document.getElementById("flight3-transition-styles")) return;

    const style = document.createElement("style");
    style.id = "flight3-transition-styles";
    style.setAttribute("data-flight3-transition-styles", "");
    style.setAttribute("data-swup-persist", "flight3-transition-styles");
    style.textContent = `
      :root {
        --f3-page-bg: #fdfdfd;
        --f3-page-bg-dark: #141414;
        --f3-transition-shade: #141414;
        --f3-transition-page-z: 100;
        --f3-transition-shade-z: 90;
        --f3-nav-z: 120;
        --f3-video-modal-page-z: 180;
        --f3-panel-z: 200;
        --f3-intro-z: 300;
        --f3-intro-bg: #141414;
      }

      html {
        background: var(--f3-page-bg-dark);
        scrollbar-gutter: stable;
      }

      body { background: var(--f3-page-bg-dark); }

      #swup.transition-page {
        position: relative;
        z-index: 1;
        width: 100%;
        min-height: 100vh;
        background: var(--f3-page-bg);
        transform-origin: 50% 0%;
        isolation: isolate;
      }

      #swup[data-transition-bg="dark"] {
        background: var(--f3-page-bg-dark);
      }

      html.has-video-modal-open #swup.transition-page,
      html[data-video-modal-open] #swup.transition-page,
      html:has(#videoModal.is--open) #swup.transition-page {
        z-index: var(--f3-video-modal-page-z);
      }

      #swup[data-flight3-next] {
        position: fixed;
        z-index: var(--f3-transition-page-z);
        top: 0;
        right: 0;
        left: 0;
        width: 100%;
        min-height: 100vh;
        visibility: hidden;
        transform: translate3d(0, 100vh, 0);
        will-change: transform;
      }

      #swup.is-previous-container {
        transform-origin: 50% 0%;
        will-change: transform;
      }

      [data-transition-shade] {
        position: fixed;
        z-index: var(--f3-transition-shade-z);
        inset: 0;
        visibility: hidden;
        background: var(--f3-transition-shade);
        opacity: 0;
        pointer-events: none;
      }

      html.is-transitioning [data-transition-shade] { visibility: visible; }

      [data-transition-nav] {
        z-index: var(--f3-nav-z);
      }

      html.is-transitioning {
        cursor: progress;
        overflow: hidden;
      }

      html.is-transitioning #swup,
      html.is-transitioning [data-transition-nav] { pointer-events: none; }
      html.has-form-panel-open,
      html.has-contact-panel-open,
      html.has-video-modal-open,
      html.has-mobile-nav-open,
      html.has-mobile-nav-open body {
        overflow: hidden;
        overscroll-behavior: none;
      }

      html.is-transition-preparing [data-transition-heading],
      html.is-transition-preparing [data-transition-paragraph],
      html.is-transition-preparing [data-transition-reveal] {
        visibility: hidden !important;
      }

      [data-transition-heading],
      [data-transition-paragraph],
      [data-transition-reveal] { backface-visibility: hidden; }

      /* Persistent once-per-session intro shell. */
      [data-site-intro] {
        position: fixed;
        z-index: var(--f3-intro-z);
        inset: 0;
        visibility: hidden;
        overflow: hidden;
        background: var(--f3-intro-bg);
        clip-path: inset(0% 0% 0% 0%);
        pointer-events: none;
      }

      html.is-intro-pending [data-site-intro] {
        visibility: visible;
        pointer-events: auto;
      }

      html.is-intro-pending {
        overflow: hidden;
      }

      html.is-intro-pending:not(.is-intro-playing) #swup,
      html.is-intro-pending:not(.is-intro-playing) [data-transition-nav] {
        visibility: hidden !important;
      }

      [data-site-intro-inner] {
        display: flex;
        width: 100%;
        height: 100%;
        align-items: center;
        justify-content: center;
      }

      [data-site-intro-lottie] {
        width: min(32rem, 72vw);
        max-width: 100%;
        aspect-ratio: 1;
      }

      [data-site-intro-lottie] svg,
      [data-site-intro-lottie] canvas {
        display: block;
        width: 100% !important;
        height: 100% !important;
      }

      [data-form-panel],
      [data-contact-panel] {
        display: none;
        position: fixed;
        z-index: var(--f3-panel-z);
        inset: 0;
        overflow: hidden;
        pointer-events: none;
      }

      [data-form-panel].is-open,
      [data-contact-panel].is-open {
        display: block;
        pointer-events: auto;
      }

      [data-form-backdrop],
      [data-contact-panel-backdrop] {
        position: fixed;
        z-index: 180;
        inset: 0;
        width: 100%;
        height: 100%;
        margin: 0;
        padding: 0;
        border: 0;
        background: rgba(17, 17, 17, 0.5);
        -webkit-backdrop-filter: blur(5px);
        backdrop-filter: blur(5px);
        cursor: pointer;
        visibility: hidden;
        opacity: 0;
      }

      [data-form-dialog],
      [data-contact-panel-dialog] {
        position: absolute;
        z-index: 190;
        overflow-x: hidden;
        overflow-y: auto;
        overscroll-behavior: contain;
        -webkit-overflow-scrolling: touch;
        touch-action: pan-y;
        outline: none;
        visibility: hidden;
        opacity: 0;
      }

      [data-form-panel].is-open [data-form-dialog],
      [data-form-panel].is-open [data-contact-panel-dialog],
      [data-contact-panel].is-open [data-form-dialog],
      [data-contact-panel].is-open [data-contact-panel-dialog] {
        display: flex;
        position: absolute;
        inset: 0;
        flex-direction: row;
        align-items: stretch;
        justify-content: flex-end;
      }

      [data-form-dialog] .w-form,
      [data-contact-panel-dialog] .w-form { position: relative; }

      @media (max-width: 767px) {
        #swup.transition-page {
          min-height: 100svh;
          transform: none;
        }

        #swup[data-flight3-next] {
          min-height: 100svh;
          transform: translate3d(0, 100svh, 0);
        }

        #swup[data-page="contact"] .section.is--c-contact {
          height: auto;
          min-height: 100svh;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        html.is-transition-preparing [data-transition-heading],
        html.is-transition-preparing [data-transition-paragraph],
        html.is-transition-preparing [data-transition-reveal] {
          visibility: visible !important;
        }

        #swup[data-flight3-next] {
          visibility: visible;
          transform: none;
        }

        [data-site-intro] { display: none !important; }

        html.is-intro-pending:not(.is-intro-playing) #swup,
        html.is-intro-pending:not(.is-intro-playing) [data-transition-nav] {
          visibility: visible !important;
        }
      }
    `;

    document.head.appendChild(style);
  }

  ensureTransitionStyles();

  const api = (window.Flight3 = window.Flight3 || {});
  api.version = VERSION;
  document.documentElement.setAttribute("data-flight3-version", VERSION);
  const registeredPageModules = new Set();
  const scrollLocks = new Set();

  function normalizePageModule(pageOrModule, maybeFactory) {
    if (typeof pageOrModule === "function") {
      return { page: "*", mount: pageOrModule };
    }

    if (typeof pageOrModule === "string" && typeof maybeFactory === "function") {
      return { page: pageOrModule, mount: maybeFactory };
    }

    if (pageOrModule && typeof pageOrModule === "object" && typeof pageOrModule.mount === "function") {
      return {
        page: pageOrModule.page || "*",
        mount: pageOrModule.mount,
      };
    }

    return null;
  }

  // Page modules can be declared in a small script before this controller.
  // This avoids timing problems with Webflow's async footer scripts.
  (window.Flight3PageModules || []).forEach((entry) => {
    const module = normalizePageModule(entry);
    if (module) registeredPageModules.add(module);
  });

  let lenis = null;
  let lenisRaf = null;
  let swup = null;
  let currentPageCleanup = null;
  let currentHeroCleanup = null;
  let activeTransition = null;
  let currentVisit = null;
  let cleanedVisitId = null;
  let transitionEase = "power4.inOut";
  let formPanelController = null;
  let mobileNavController = null;
  let preparedUkiyo = null;
  let lifecycleController = new AbortController();
  let refreshFrame = 0;
  let resumeFrame = 0;
  const nativeFormHandlers = new Map();
  const routeFormCleanups = new WeakMap();
  let formIdSequence = 0;

  function namespaceDuplicateFormIds(container) {
    const wrappers = Array.from(container.querySelectorAll(".w-form")).sort(
      (a, b) => Number(Boolean(b.closest("#swup"))) - Number(Boolean(a.closest("#swup"))),
    );
    wrappers.forEach((wrapper) => {
      const replacements = new Map();
      wrapper.querySelectorAll("[id]").forEach((element) => {
        const id = element.id;
        if (!id || document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length < 2) return;
        let nextId;
        do {
          nextId = `${id}--f3-${++formIdSequence}`;
        } while (document.getElementById(nextId));
        replacements.set(id, nextId);
        element.id = nextId;
      });
      wrapper.querySelectorAll("[for], [aria-labelledby], [aria-describedby], [aria-controls]").forEach((element) => {
        ["for", "aria-labelledby", "aria-describedby", "aria-controls"].forEach((name) => {
          const value = element.getAttribute(name);
          if (value)
            element.setAttribute(
              name,
              value
                .split(/\s+/)
                .map((id) => replacements.get(id) || id)
                .join(" "),
            );
        });
      });
    });
  }

  function captureNativeFormHandlers() {
    const $ = window.jQuery;
    if (!$?.data) return;
    document.querySelectorAll(".w-form form").forEach((form) => {
      const state = $.data(form, ".w-form");
      if (typeof state?.handler === "function" && state.form?.[0] === form && state.done && state.fail && state.btn) {
        nativeFormHandlers.set(form.getAttribute("action") || "", state.handler);
      }
    });
  }

  function cleanupRouteForms(container) {
    routeFormCleanups.get(container)?.();
    routeFormCleanups.delete(container);
  }

  function initializeRouteForms(container) {
    // Scoped state for the inspected native handler, not a second submit pipeline.
    const $ = window.jQuery;
    const forms = Array.from(container.querySelectorAll(".w-form form"));
    if (!forms.length) return true;
    if (!$?.data) return false;
    captureNativeFormHandlers();
    const pending = forms.filter((form) => !$.data(form, ".w-form"));
    // File uploads need Webflow's private signing/setup lifecycle. Use a native
    // document load rather than pretending they support this scoped adapter.
    if (
      pending.some((form) => {
        const action = form.getAttribute("action") || "";
        return (
          form.closest(".w-form").querySelector(".w-file-upload") ||
          ((!action || /list-manage[1-9]?.com/i.test(action)) && !nativeFormHandlers.has(action))
        );
      })
    )
      return false;

    const cleanups = [];
    let disposed = false;
    const siteKey = document.querySelector("[data-turnstile-sitekey]")?.getAttribute("data-turnstile-sitekey");
    pending.forEach((form) => {
      const wrapper = form.closest(".w-form");
      const state = {
        form: $(form),
        btn: $(form).find(':input[type="submit"]'),
        done: $(wrapper).find("> .w-form-done"),
        fail: $(wrapper).find("> .w-form-fail"),
        fileUploads: $(),
        action: form.getAttribute("action") || "",
        redirect: form.getAttribute("data-redirect"),
        success: false,
        handler: nativeFormHandlers.get(form.getAttribute("action") || "") || null,
      };
      state.wait = state.btn.attr("data-wait") || null;
      $.data(form, ".w-form", state);
      const label = form.getAttribute("aria-label") || form.getAttribute("data-name") || "Form";
      if (!form.hasAttribute("aria-label")) form.setAttribute("aria-label", label);
      [
        [state.done, "success"],
        [state.fail, "failure"],
      ].forEach(([element, status]) => {
        element.attr({ tabindex: "-1", role: "region" });
        if (!element.attr("aria-label")) element.attr("aria-label", `${label} ${status}`);
      });
      let observer = null;
      let timer = 0;
      let widgetId = null;
      let widgetHost = null;
      const needsChallenge = siteKey && state.handler && !form.hasAttribute("data-wf-no-turnstile");
      const setChallengePending = (pending) => {
        state.btn.prop("disabled", pending).toggleClass("w-form-loading", pending);
        wrapper.classList.toggle("w-form-loading", pending);
      };
      if (needsChallenge) {
        setChallengePending(true);
        const verificationDeadline = Date.now() + 30000;
        const renderChallenge = () => {
          if (disposed || !form.isConnected || widgetHost) return;
          if (!window.turnstile?.render) {
            if (Date.now() >= verificationDeadline) {
              console.warn("Flight3: form verification is unavailable; reload to retry.");
              return;
            }
            timer = window.setTimeout(renderChallenge, 100);
            return;
          }
          widgetHost = document.createElement("div");
          form.appendChild(widgetHost);
          try {
            widgetId = window.turnstile.render(widgetHost, {
              sitekey: siteKey,
              callback(token) {
                if (disposed) return;
                state.turnstileToken = token;
                setChallengePending(false);
              },
              "expired-callback"() {
                if (disposed) return;
                state.turnstileToken = null;
                setChallengePending(true);
                if (widgetId != null) window.turnstile?.reset?.(widgetId);
              },
              "error-callback"() {
                if (disposed) return;
                state.turnstileToken = null;
                setChallengePending(true);
              },
            });
          } catch (error) {
            widgetHost.remove();
            widgetHost = null;
            console.warn("Flight3: form verification could not initialize; reload this page to retry.", error);
          }
        };
        if (typeof IntersectionObserver === "function") {
          observer = new IntersectionObserver(
            (entries) => {
              if (!entries.some((entry) => entry.isIntersecting)) return;
              observer.disconnect();
              renderChallenge();
            },
            { rootMargin: "200px" },
          );
          observer.observe(form);
        } else renderChallenge();
      }
      cleanups.push(() => {
        observer?.disconnect();
        window.clearTimeout(timer);
        if (widgetId != null) window.turnstile?.remove?.(widgetId);
        widgetHost?.remove();
        $.removeData(form, ".w-form");
      });
    });
    routeFormCleanups.set(container, () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    });
    return true;
  }

  function nextPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  function animationPromise(animation, signal) {
    if (!animation || typeof animation.eventCallback !== "function") {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        animation.kill();
        finish();
      };
      const previous = animation.eventCallback("onComplete");
      const interrupted = animation.eventCallback("onInterrupt");
      animation.eventCallback("onComplete", () => {
        if (typeof previous === "function") previous.call(animation);
        finish();
      });
      animation.eventCallback("onInterrupt", () => {
        if (typeof interrupted === "function") interrupted.call(animation);
        finish();
      });
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }

  function numericAttribute(element, name, fallback) {
    const value = Number.parseFloat(element?.getAttribute(name));
    return Number.isFinite(value) ? value : fallback;
  }

  function getTransitionEase() {
    return transitionEase;
  }

  function setDocumentBusy(isBusy) {
    if (isBusy) document.documentElement.setAttribute("aria-busy", "true");
    else document.documentElement.removeAttribute("aria-busy");
  }

  function isTouchEnvironment() {
    return navigator.maxTouchPoints > 0 || window.matchMedia("(pointer: coarse)").matches || Number(window.ScrollTrigger?.isTouch) > 0;
  }

  function setScrollLock(owner, shouldLock) {
    if (shouldLock) scrollLocks.add(owner);
    else scrollLocks.delete(owner);

    if (scrollLocks.size) {
      lenis?.stop?.();
      return;
    }

    const resume = () => {
      if (scrollLocks.size) return;
      lenis?.start?.();

      // Fail-safe for Lenis' stopped class after a route-owned overflow lock.
      document.documentElement.classList.remove("lenis-stopped");
    };

    resume();
    cancelAnimationFrame(resumeFrame);
    resumeFrame = requestAnimationFrame(resume);
    refreshScrollSystems();
  }

  function refreshScrollSystems() {
    if (refreshFrame) return;
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = 0;
      lenis?.resize?.();
      window.ScrollTrigger?.refresh?.();
    });
  }

  function initLenisOnce() {
    if (lenis || typeof window.Lenis === "undefined") return;
    if (isTouchEnvironment()) return;

    lenis = new window.Lenis({
      duration: 1.15,
      easing: (t) => 1 - Math.pow(1 - t, 3),
      orientation: "vertical",
      gestureOrientation: "vertical",
      smoothWheel: !reducedMotion.matches,
      wheelMultiplier: 0.75,
      allowNestedScroll: true,
      anchors: true,
      // Route and drawer locks are owned by setScrollLock(). autoToggle reads
      // overflow:hidden and can create a self-sustaining lenis-stopped loop.
      autoToggle: false,
      stopInertiaOnNavigate: true,
      autoRaf: false,
    });

    lenis.on("scroll", window.ScrollTrigger.update);
    lenisRaf = (time) => lenis?.raf?.(time * 1000);
    window.gsap.ticker.add(lenisRaf);
    window.gsap.ticker.lagSmoothing(0);

    api.lenis = lenis;
    reducedMotion.addEventListener("change", () => {
      lenis.options.smoothWheel = !reducedMotion.matches;
    });
  }

  function initMobileNavOnce() {
    const nav = document.querySelector(".nav");
    const openControls = Array.from(document.querySelectorAll('[data-mobile-nav="open"]'));
    const closeControls = Array.from(document.querySelectorAll('[data-mobile-nav="close"]'));
    const navItems = Array.from(document.querySelectorAll(".nav_m-inner .is--nav-item"));

    if (!nav || !openControls.length) return null;
    if (nav.__flight3MobileNav) return nav.__flight3MobileNav;

    // The nav is persistent and must stay outside #swup.
    const menu = nav.querySelector(".nav_m-inner");
    const focusTrap = createFlight3FocusTrap(nav);
    let lastFocused = null;
    if (menu && !menu.id) menu.id = "flight3-mobile-menu";
    [...openControls, ...closeControls].forEach((control) => {
      enhanceFlight3Button(control);
      if (menu) control.setAttribute("aria-controls", menu.id);
      if (!control.hasAttribute("aria-label")) {
        control.setAttribute("aria-label", openControls.includes(control) ? "Open menu" : "Close menu");
      }
    });
    const setMenuAvailability = (open) => {
      if (!menu) return;
      menu.inert = !open;
      menu.setAttribute("aria-hidden", String(!open));
    };

    let isOpen = nav.getAttribute("data-m-menu") === "active" || openControls.some((control) => control.classList.contains("is--open"));

    const updateOpenControls = (open) => {
      openControls.forEach((control) => {
        control.classList.toggle("is--open", open);
        control.setAttribute("aria-expanded", String(open));
      });
    };

    const setClosedState = () => {
      window.gsap.set(navItems, { y: "-4rem", opacity: 0 });
    };

    const close = ({ immediate = false } = {}) => {
      const wasOpen = isOpen;
      isOpen = false;
      setMenuAvailability(false);
      focusTrap.deactivate();
      if (wasOpen && !immediate) lastFocused?.focus?.({ preventScroll: true });
      lastFocused = null;
      updateOpenControls(false);
      nav.setAttribute("data-m-menu", "inactive");
      document.documentElement.classList.remove("has-mobile-nav-open");
      setScrollLock("mobile-nav", false);
      window.gsap.killTweensOf(navItems);

      if (immediate || reducedMotion.matches) {
        setClosedState();
        return;
      }

      window.gsap.to(navItems, {
        y: "-4rem",
        opacity: 0,
        duration: 0.5,
        ease: "power2.in",
        stagger: {
          each: 0.04,
          from: "end",
        },
      });
    };

    const open = () => {
      if (window.innerWidth > 767 || isOpen) return;

      isOpen = true;
      lastFocused = document.activeElement;
      setMenuAvailability(true);
      focusTrap.activate();
      updateOpenControls(true);
      nav.setAttribute("data-m-menu", "active");
      document.documentElement.classList.add("has-mobile-nav-open");
      setScrollLock("mobile-nav", true);
      window.gsap.killTweensOf(navItems);
      const focusTarget = closeControls.find((element) => element.getClientRects().length) || menu?.querySelector("a[href]");
      focusTarget?.focus?.({ preventScroll: true });

      if (reducedMotion.matches) {
        window.gsap.set(navItems, { y: "0rem", opacity: 1 });
        return;
      }

      window.gsap.to(navItems, {
        y: "0rem",
        opacity: 1,
        duration: 0.6,
        delay: 0.3,
        ease: "power2.out",
        stagger: 0.06,
      });
    };

    const handleOpen = (event) => {
      if (window.innerWidth > 767) return;
      event?.preventDefault?.();
      open();
    };

    const handleClose = (event) => {
      if (window.innerWidth > 767) return;
      event?.preventDefault?.();
      close();
    };

    openControls.forEach((control) => {
      control.addEventListener("click", handleOpen);
    });
    closeControls.forEach((control) => {
      control.addEventListener("click", handleClose);
    });
    document.addEventListener("keydown", (event) => {
      if (!isOpen || event.key !== "Escape") return;
      event.preventDefault();
      close();
    });

    window.matchMedia("(min-width: 768px)").addEventListener("change", (event) => {
      if (event.matches) close({ immediate: true });
    });

    if (isOpen && window.innerWidth <= 767) {
      setMenuAvailability(true);
      focusTrap.activate();
      updateOpenControls(true);
      nav.setAttribute("data-m-menu", "active");
      document.documentElement.classList.add("has-mobile-nav-open");
      setScrollLock("mobile-nav", true);
      window.gsap.set(navItems, { y: "0rem", opacity: 1 });
    } else {
      close({ immediate: true });
    }

    const controller = {
      open,
      close,
      get isOpen() {
        return isOpen;
      },
    };
    nav.__flight3MobileNav = controller;
    return controller;
  }

  function rememberStyle(element, map) {
    if (!map.has(element)) map.set(element, element.getAttribute("style"));
  }

  function restoreStyles(map) {
    map.forEach((style, element) => {
      if (!element.isConnected) return;
      if (style === null) element.removeAttribute("style");
      else element.setAttribute("style", style);
    });
  }

  function boundedStagger(targets, each) {
    if (targets.length < 2) return 0;
    return { amount: Math.min(0.55, each * (targets.length - 1)) };
  }

  function readEntranceTiming(element, defaults) {
    return {
      at: Math.max(0, numericAttribute(element, "data-transition-at", defaults.at) + numericAttribute(element, "data-transition-delay", 0)),
      duration: Math.max(0.01, numericAttribute(element, "data-transition-duration", defaults.duration)),
      stagger: numericAttribute(element, "data-transition-stagger", defaults.stagger),
    };
  }

  function addSplitEntrance(timeline, element, options, state) {
    if (typeof window.SplitText === "undefined") {
      addElementEntrance(
        timeline,
        element,
        {
          ...options,
          type: "fade-up",
        },
        state,
      );
      return;
    }

    const splitType = options.splitBy === "lines" ? "lines" : "words";
    const split = window.SplitText.create(element, {
      type: splitType,
      mask: splitType,
      aria: "auto",
    });

    const targets = splitType === "lines" ? split.lines : split.words;
    state.splits.push(split);

    /*
     * SplitText's word masks correctly hide the vertical entrance, but an
     * italic glyph can overhang its measured word box on the inline end. Give
     * only italic word masks a compensated gutter so <em> remains visually
     * identical before and after SplitText.revert().
     */
    if (splitType === "words" && split.masks?.length) {
      split.masks.forEach((mask, index) => {
        const word = split.words[index];
        const containsItalic =
          mask.matches?.("em, i") ||
          mask.querySelector?.("em, i") ||
          mask.closest?.("em, i") ||
          word?.matches?.("em, i") ||
          word?.querySelector?.("em, i") ||
          word?.closest?.("em, i");

        if (!containsItalic) return;
        mask.style.paddingInlineEnd = "0.16em";
        mask.style.marginInlineEnd = "-0.16em";
      });
    }

    if (!targets.length) return;

    window.gsap.set(targets, {
      yPercent: 110,
      autoAlpha: options.opacity === false ? 1 : 0,
    });

    timeline.to(
      targets,
      {
        yPercent: 0,
        autoAlpha: 1,
        duration: options.duration,
        ease: options.ease,
        stagger: boundedStagger(targets, options.stagger),
      },
      options.at,
    );
  }

  function addElementEntrance(timeline, element, options, state) {
    rememberStyle(element, state.styles);

    const type = options.type || "fade-up";
    const from = { autoAlpha: type === "clip-up" ? 1 : 0 };
    const to = {
      autoAlpha: 1,
      duration: options.duration,
      ease: options.ease,
    };

    if (type === "fade-up" || type === "clip-up") {
      from.y = 40;
      to.y = 0;
    }

    if (type === "scale") {
      from.scale = 1.04;
      to.scale = 1;
    }

    if (type === "clip-up") {
      from.clipPath = "inset(100% 0 0 0)";
      to.clipPath = "inset(0% 0 0 0)";
    }

    window.gsap.set(element, from);
    timeline.to(element, to, options.at);
  }

  function prepareDefaultEntrance(page) {
    const timeline = window.gsap.timeline({ paused: true });
    const state = { splits: [], styles: new Map() };

    page.querySelectorAll("[data-transition-heading]").forEach((element) => {
      const type = element.getAttribute("data-transition-heading") || "words-up";
      if (type === "none") return;

      const timing = readEntranceTiming(element, {
        at: 0,
        duration: 1.25,
        stagger: 0.1,
      });

      if (type === "fade-up") {
        addElementEntrance(timeline, element, { ...timing, type, ease: "power3.out" }, state);
        return;
      }

      addSplitEntrance(
        timeline,
        element,
        {
          ...timing,
          splitBy: type === "lines-up" ? "lines" : "words",
          ease: "power3.out",
          opacity: false,
        },
        state,
      );
    });

    page.querySelectorAll("[data-transition-paragraph]").forEach((element) => {
      const type = element.getAttribute("data-transition-paragraph") || "lines-up";
      if (type === "none") return;

      const timing = readEntranceTiming(element, {
        at: 0.14,
        duration: 1.05,
        stagger: 0.08,
      });

      if (type === "fade-up") {
        addElementEntrance(timeline, element, { ...timing, type, ease: "power3.out" }, state);
        return;
      }

      addSplitEntrance(
        timeline,
        element,
        {
          ...timing,
          splitBy: type === "words-up" ? "words" : "lines",
          ease: "power3.out",
          opacity: true,
        },
        state,
      );
    });

    page.querySelectorAll("[data-transition-reveal]").forEach((element) => {
      const type = element.getAttribute("data-transition-reveal") || "fade-up";
      if (type === "none") return;

      const timing = readEntranceTiming(element, {
        at: 0.24,
        duration: 1,
        stagger: 0,
      });

      addElementEntrance(timeline, element, { ...timing, type, ease: "power3.out" }, state);
    });

    return {
      timeline,
      cleanup() {
        state.splits.forEach((split) => split.revert());
        restoreStyles(state.styles);
      },
    };
  }

  function preparePageEntrance(container) {
    const page = container?.querySelector(CONFIG.pageSelector) || container;

    if (!page || reducedMotion.matches) {
      return {
        timeline: window.gsap.timeline({ paused: true }),
        cleanup() {},
      };
    }

    return prepareDefaultEntrance(page);
  }

  function syncInitialNavTheme(container, { atScroll = false } = {}) {
    const sections = Array.from(container?.querySelectorAll("[data-theme-section], [data-bg-section]") || []);
    let firstSection = sections[0];
    if (atScroll) {
      const navCenter = (document.querySelector("[data-nav-bar-height]")?.offsetHeight || 0) / 2;
      for (const section of sections) {
        const bounds = section.getBoundingClientRect();
        if (bounds.top <= navCenter) firstSection = section;
        if (bounds.top <= navCenter && bounds.bottom > navCenter) break;
      }
    }

    if (!firstSection) return;

    const theme = firstSection.getAttribute("data-theme-section");
    const background = firstSection.getAttribute("data-bg-section");

    if (theme) {
      document.querySelectorAll("[data-theme-nav]").forEach((element) => {
        element.setAttribute("data-theme-nav", theme);
      });
    }

    if (background) {
      document.querySelectorAll("[data-bg-nav]").forEach((element) => {
        element.setAttribute("data-bg-nav", background);
      });
    }
  }

  function normalizePagePath(urlLike = window.location.href) {
    let url;

    try {
      const value = typeof urlLike === "string" ? urlLike : urlLike?.url || urlLike?.href || window.location.href;
      url = new URL(value, window.location.href);
    } catch (error) {
      url = new URL(window.location.href);
    }

    let path = url.pathname.replace(/\/index\.html?$/i, "/");
    if (path.length > 1) path = path.replace(/\/+$/, "");
    return path || "/";
  }

  function syncWebflowCurrentLinks(urlLike = window.location.href) {
    const currentPath = normalizePagePath(urlLike);

    document.querySelectorAll(CONFIG.navSelector).forEach((nav) => {
      nav.querySelectorAll("a[href]").forEach((link) => {
        const rawHref = link.getAttribute("href")?.trim() || "";
        let isCurrent = false;

        if (rawHref && !rawHref.startsWith("#")) {
          try {
            const destination = new URL(rawHref, window.location.href);
            isCurrent =
              /^https?:$/.test(destination.protocol) &&
              destination.origin === window.location.origin &&
              normalizePagePath(destination) === currentPath;
          } catch (error) {
            isCurrent = false;
          }
        }

        link.classList.toggle("w--current", isCurrent);

        if (isCurrent) {
          link.setAttribute("aria-current", "page");
        } else if (link.getAttribute("aria-current") === "page") {
          link.removeAttribute("aria-current");
        }
      });
    });
  }

  function getParallelContainers() {
    const containers = Array.from(document.querySelectorAll(CONFIG.routerSelector));
    const previous = containers.find((element) => element.classList.contains("is-previous-container"));
    const next = containers.find((element) => element !== previous);

    return { previous, next };
  }

  async function waitForEntranceMedia(container, signal) {
    if (signal?.aborted) return;
    const containerTop = container.getBoundingClientRect().top;
    const entranceLimit = window.innerHeight * 1.2;
    const images = Array.from(
      new Set(container.querySelectorAll("[data-transition-reveal] img, img[data-transition-reveal], [data-ukiyo]")),
    ).filter((element) => element instanceof HTMLImageElement && element.getBoundingClientRect().top - containerTop < entranceLimit);

    const pendingImages = images.filter((image) => !image.complete || image.naturalWidth === 0);

    const listenerCleanups = [];
    const readinessTasks = pendingImages.map((image) => {
      if (typeof image.decode === "function") {
        return image.decode().catch(() => undefined);
      }

      return new Promise((resolve) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", resolve, { once: true });
        listenerCleanups.push(() => {
          image.removeEventListener("load", resolve);
          image.removeEventListener("error", resolve);
        });
      });
    });

    /* SplitText must measure the final font metrics before creating masks. */
    if (document.fonts?.ready) {
      readinessTasks.push(document.fonts.ready.catch(() => undefined));
    }

    if (!readinessTasks.length) return;

    await new Promise((resolve) => {
      const finish = () => {
        window.clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        listenerCleanups.forEach((cleanup) => cleanup());
        resolve();
      };
      const timer = window.setTimeout(finish, 1200);
      signal?.addEventListener("abort", finish, { once: true });
      Promise.allSettled(readinessTasks).then(finish);
    });
  }

  function cleanupPreparedUkiyo() {
    preparedUkiyo?.cleanup?.();
    preparedUkiyo = null;
  }

  function prepareIncomingUkiyo(container) {
    cleanupPreparedUkiyo();

    const root = container.querySelector(CONFIG.pageSelector) || container;
    const abortController = new AbortController();
    const cleanupTasks = [];
    initUkiyo(root, abortController.signal, cleanupTasks);

    if (!cleanupTasks.length) {
      abortController.abort();
      return;
    }

    let cleaned = false;
    preparedUkiyo = {
      container,
      cleanup() {
        if (cleaned) return;
        cleaned = true;
        abortController.abort();
        cleanupTasks.reverse().forEach((cleanup) => cleanup());
      },
    };
  }

  function claimPreparedUkiyo(container, cleanupTasks) {
    if (preparedUkiyo?.container !== container) return false;

    const prepared = preparedUkiyo;
    preparedUkiyo = null;
    cleanupTasks.push(prepared.cleanup);
    return true;
  }

  async function playParallelTransition() {
    const visit = currentVisit;
    const signal = lifecycleController.signal;
    const { previous, next } = getParallelContainers();
    const nav = document.querySelector(CONFIG.navSelector);
    const shade = document.querySelector(CONFIG.shadeSelector);

    if (!previous || !next) {
      next?.removeAttribute("data-flight3-next");
      window.gsap.set(next || CONFIG.routerSelector, {
        clearProps: "all",
      });
      return;
    }

    // Ukiyo changes the image DOM and writes explicit geometry. Do that while
    // the incoming page is still hidden so the hero cannot resize after reveal.
    await waitForEntranceMedia(next, signal);
    if (signal.aborted || currentVisit !== visit || !next.isConnected) return;
    prepareIncomingUkiyo(next);

    const entrance = preparePageEntrance(next);
    let entranceCleaned = false;
    const finishEntrance = () => {
      if (entranceCleaned) return;
      entranceCleaned = true;
      entrance.cleanup();
      if (currentHeroCleanup === cancelEntrance) {
        currentHeroCleanup = null;
      }
    };
    const cancelEntrance = () => {
      entrance.timeline.kill();
      finishEntrance();
    };
    currentHeroCleanup = cancelEntrance;
    syncInitialNavTheme(next);

    window.gsap.set(next, {
      autoAlpha: 1,
      willChange: "transform",
    });

    window.gsap.set(previous, {
      transformOrigin: "50% 0%",
      willChange: "transform",
    });

    if (shade) {
      window.gsap.set(shade, { autoAlpha: 0, willChange: "opacity" });
    }

    if (nav) {
      window.gsap.set(nav, { willChange: "transform, opacity" });
    }

    const timeline = window.gsap.timeline();
    activeTransition = timeline;

    timeline
      .addLabel("transition", 0)
      .to(
        previous,
        {
          y: CONFIG.pageTravel,
          scale: CONFIG.pageScale,
          duration: CONFIG.transitionDuration,
          ease: getTransitionEase(),
        },
        "transition",
      )
      .to(
        next,
        {
          y: 0,
          duration: CONFIG.transitionDuration,
          ease: getTransitionEase(),
        },
        "transition",
      );

    if (shade) {
      timeline.to(
        shade,
        {
          autoAlpha: 0.72,
          duration: 1,
          ease: "power1.out",
        },
        "transition",
      );
    }

    if (nav) {
      timeline
        .to(
          nav,
          {
            y: CONFIG.navExitY,
            autoAlpha: 0,
            duration: 0.55,
            ease: "power3.in",
          },
          "transition",
        )
        .set(
          nav,
          {
            y: CONFIG.navEnterY,
            autoAlpha: 0,
          },
          "transition+=0.64",
        )
        .to(
          nav,
          {
            y: 0,
            autoAlpha: 1,
            duration: 0.9,
            ease: "power3.out",
          },
          "transition+=0.76",
        );
    }

    // The hero starts while the page is still travelling, but it does not
    // hold Swup's route lifecycle open. Scroll unlocks as soon as the page/nav
    // choreography settles while the final hero words can finish naturally.
    entrance.timeline.pause(0);
    timeline.call(
      () => {
        entrance.timeline.eventCallback("onComplete", finishEntrance);
        entrance.timeline.play(0);
      },
      null,
      CONFIG.heroStart,
    );

    await animationPromise(timeline, signal);
    if (signal.aborted || currentVisit !== visit) return;

    /* Reset while the incoming page is still the fixed transition layer.
       This prevents the outgoing route's scroll position from becoming the
       first painted position of a normal forward navigation. */
    if (shouldResetVisitScroll(visit)) {
      resetScrollPosition();
    }
  }

  function resetTransitionPresentation() {
    const container = document.querySelector(CONFIG.routerSelector);
    const nav = document.querySelector(CONFIG.navSelector);
    const shade = document.querySelector(CONFIG.shadeSelector);

    container?.removeAttribute("data-flight3-next");

    if (container) {
      window.gsap.set(container, {
        clearProps: "transform,visibility,opacity,willChange",
      });
    }

    if (nav) {
      window.gsap.set(nav, {
        clearProps: "transform,opacity,visibility,willChange",
      });
    }

    if (shade) {
      window.gsap.set(shade, {
        clearProps: "opacity,visibility,willChange",
      });
    }
  }

  function updateWebflowPageId(visit) {
    const nextHtml = visit?.to?.document?.documentElement;
    if (!nextHtml) return;
    ["data-wf-page", "data-wf-collection", "data-wf-item-slug"].forEach((name) => {
      const value = nextHtml.getAttribute(name);
      if (value) document.documentElement.setAttribute(name, value);
      else if (name !== "data-wf-page") document.documentElement.removeAttribute(name);
    });
  }

  async function reinitializeWebflow(container) {
    const Webflow = window.Webflow;
    if (!Webflow || typeof Webflow.require !== "function") return;
    namespaceDuplicateFormIds(container);
    if (!initializeRouteForms(container)) {
      container.inert = true;
      setDocumentBusy(true);
      window.location.replace(window.location.href);
      return false;
    }

    /* Flight3 owns all animation lifecycles. Do not destroy or initialise
       Webflow IX2/IX3 here. Only rescan functional Webflow components that
       can arrive inside the replaced #swup container. */
    const modules = [
      ["slider", ".w-slider"],
      ["tabs", ".w-tabs"],
      ["dropdown", ".w-dropdown"],
      ["lightbox", ".w-lightbox"],
      ["lottie", "[data-animation-type='lottie']"],
    ];

    for (const [name, selector] of modules) {
      if (!container?.querySelector(selector)) continue;

      try {
        Webflow.require(name)?.ready?.();
      } catch (error) {
        console.warn(`Flight3: Webflow ${name} could not be initialised.`, error);
      }
    }
    return true;
  }

  function initThemeTracking(root, cleanupTasks) {
    const sections = Array.from(root.querySelectorAll("[data-theme-section], [data-bg-section]"));
    if (!sections.length) return;

    const navBarHeight = document.querySelector("[data-nav-bar-height]");
    const themeTargets = document.querySelectorAll("[data-theme-nav]");
    const backgroundTargets = document.querySelectorAll("[data-bg-nav]");
    let currentTheme = null;
    let currentBackground = null;

    const applySection = (section) => {
      const theme = section.getAttribute("data-theme-section");
      const background = section.getAttribute("data-bg-section");

      if (theme && theme !== currentTheme) {
        themeTargets.forEach((element) => {
          element.setAttribute("data-theme-nav", theme);
        });
        currentTheme = theme;
      }

      if (background && background !== currentBackground) {
        backgroundTargets.forEach((element) => {
          element.setAttribute("data-bg-nav", background);
        });
        currentBackground = background;
      }
    };

    let navCenter = 0;
    const measureNav = () => {
      navCenter = navBarHeight ? navBarHeight.offsetHeight / 2 : 0;
    };
    measureNav();
    window.ScrollTrigger.addEventListener("refreshInit", measureNav);
    cleanupTasks.push(() => window.ScrollTrigger.removeEventListener("refreshInit", measureNav));

    /* ScrollTrigger already owns the scroll update cycle and caches section
       geometry between refreshes. Reuse it instead of running a second RAF
       loop that reads every section rect on every scroll frame. */
    sections.forEach((section) => {
      window.ScrollTrigger.create({
        trigger: section,
        start: () => `top ${navCenter}px`,
        end: () => `bottom ${navCenter}px`,
        invalidateOnRefresh: true,
        onEnter: () => applySection(section),
        onEnterBack: () => applySection(section),
        onRefresh(self) {
          if (self.isActive) applySection(section);
        },
      });
    });
  }

  function initSplitHeadings(root, splitInstances) {
    if (typeof window.SplitText === "undefined") return;

    root.querySelectorAll("[data-split-heading]").forEach((heading) => {
      // One element must have one animation owner.
      if (heading.hasAttribute("data-transition-heading")) return;

      const split = window.SplitText.create(heading, {
        type: "lines",
        autoSplit: true,
        mask: "lines",
        onSplit(instance) {
          return window.gsap.from(instance.lines, {
            duration: 1,
            yPercent: 110,
            stagger: 0.1,
            ease: "expo.out",
            scrollTrigger: {
              trigger: heading,
              start: "top 75%",
              once: true,
            },
          });
        },
      });

      splitInstances.push(split);
    });
  }

  function initSectionParallax(root, cleanupTasks, styleRecords) {
    const parallaxSections = Array.from(root.querySelectorAll("[data-sec-plx]"));
    const revealSections = Array.from(root.querySelectorAll("[data-sec-rev]"));
    if (!parallaxSections.length && !revealSections.length) return;

    const overlayColor = (value) => (value === "light" ? "#fdfdfd" : "#141414");
    const responsiveStyles = new Map();
    const media = window.gsap.matchMedia();

    media.add(
      {
        mobile: "(max-width: 767px)",
        desktop: "(min-width: 768px)",
        reduceMotion: "(prefers-reduced-motion: reduce)",
      },
      (context) => {
        if (context.conditions.reduceMotion) return;

        const distance = context.conditions.mobile ? 150 : 300;
        const scrub = context.conditions.mobile ? 1 : 0.5;
        const overlays = [];

        const createOverlay = (section, color) => {
          rememberStyle(section, styleRecords);
          rememberStyle(section, responsiveStyles);

          if (getComputedStyle(section).position === "static") {
            section.style.position = "relative";
          }

          section.style.isolation = "isolate";

          const overlay = document.createElement("div");
          overlay.setAttribute("data-flight3-section-overlay", "");
          Object.assign(overlay.style, {
            position: "absolute",
            inset: "0",
            zIndex: "2",
            pointerEvents: "none",
            background: color,
            opacity: "0",
            willChange: "opacity",
          });
          section.appendChild(overlay);
          overlays.push(overlay);
          return overlay;
        };

        parallaxSections.forEach((section) => {
          const nextSection = section.nextElementSibling;
          if (!nextSection) return;

          rememberStyle(section, styleRecords);
          rememberStyle(section, responsiveStyles);
          section.style.willChange = "transform";

          const overlay = createOverlay(section, overlayColor(section.getAttribute("data-sec-plx")));

          window.gsap
            .timeline({
              scrollTrigger: {
                trigger: nextSection,
                start: "top bottom",
                end: "top 15%",
                scrub,
                invalidateOnRefresh: true,
              },
            })
            .to(section, { y: distance, ease: "none" }, 0)
            .to(overlay, { opacity: 0.75, ease: "none" }, 0);
        });

        revealSections.forEach((section) => {
          const previousSection = section.previousElementSibling;
          if (!previousSection) return;

          [section, previousSection].forEach((element) => {
            rememberStyle(element, styleRecords);
            rememberStyle(element, responsiveStyles);
          });

          const overlay = createOverlay(section, overlayColor(section.getAttribute("data-sec-rev")));

          window.gsap.set(previousSection, {
            zIndex: 1,
            position: "relative",
          });
          window.gsap.set(section, {
            y: -distance,
            willChange: "transform",
          });
          window.gsap.set(overlay, { opacity: 0.75 });

          window.gsap
            .timeline({
              scrollTrigger: {
                trigger: previousSection,
                start: "bottom bottom",
                end: "bottom 10%",
                scrub,
                invalidateOnRefresh: true,
              },
            })
            .to(section, { y: 0, ease: "none" }, 0)
            .to(overlay, { opacity: 0, ease: "none" }, 0);
        });

        return () => {
          overlays.forEach((overlay) => overlay.remove());
          restoreStyles(responsiveStyles);
        };
      },
    );

    cleanupTasks.push(() => {
      media.revert();
      restoreStyles(responsiveStyles);
    });
  }

  function initGroupAnimations(root) {
    root.querySelectorAll("[data-anim-group-in]").forEach((group) => {
      const children = Array.from(group.children);
      if (!children.length) return;

      window.gsap.fromTo(
        children,
        { autoAlpha: 0, yPercent: 100 },
        {
          autoAlpha: 1,
          yPercent: 0,
          duration: 1,
          ease: "power3.out",
          stagger: 0.1,
          scrollTrigger: {
            trigger: group,
            start: "top 85%",
            once: true,
          },
        },
      );
    });
  }

  function initScrollGroups(root) {
    root.querySelectorAll("[data-scroll-group]").forEach((group) => {
      const items = Array.from(group.children);
      if (!items.length) return;

      const offset = 20;
      const timeline = window.gsap.timeline({
        scrollTrigger: {
          trigger: group,
          start: "top bottom",
          end: "bottom top",
          scrub: true,
          invalidateOnRefresh: true,
        },
      });

      items.forEach((item, index) => {
        const itemOffset = index * offset;

        timeline
          .fromTo(item, { yPercent: 100 + itemOffset }, { yPercent: 0, ease: "none", duration: 0.5 }, 0)
          .to(item, { yPercent: -20 - itemOffset, ease: "none", duration: 0.5 }, 0.5);
      });
    });
  }

  function initUkiyo(root, signal, cleanupTasks) {
    if (typeof window.Ukiyo === "undefined") return;

    const images = Array.from(root.querySelectorAll("[data-ukiyo]"));
    if (!images.length) return;

    const media = window.gsap.matchMedia();
    let instance = null;
    let resizeTimer = 0;
    let lastViewportWidth = window.innerWidth;

    const resize = () => {
      const nextViewportWidth = window.innerWidth;
      const widthChanged = Math.abs(nextViewportWidth - lastViewportWidth) > 1;
      lastViewportWidth = nextViewportWidth;
      if (!widthChanged && isTouchEnvironment()) return;

      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => instance?.reset?.(), 150);
    };

    window.addEventListener("resize", resize, { passive: true, signal });

    media.add(
      {
        mobile: "(max-width: 767px)",
        desktop: "(min-width: 768px)",
        reduceMotion: "(prefers-reduced-motion: reduce)",
      },
      (context) => {
        if (context.conditions.reduceMotion) return;

        const isMobile = context.conditions.mobile;
        instance = new window.Ukiyo(images, {
          scale: isMobile ? 1.08 : 1.15,
          speed: isMobile ? 1 : 1.2,
          willChange: true,
          wrapperClass: "ukiyo-wrapper",
        });

        return () => {
          instance?.destroy?.();
          instance = null;
        };
      },
    );

    cleanupTasks.push(() => {
      window.clearTimeout(resizeTimer);
      media.revert();
      instance?.destroy?.();
      instance = null;
    });
  }

  function mountRegisteredModules(root, signal, cleanupTasks) {
    const page =
      root.getAttribute("data-page") ||
      root.closest(CONFIG.routerSelector)?.getAttribute("data-page") ||
      root.getAttribute("data-page-module") ||
      "";

    const simplePages = window.Flight3Pages;
    if (simplePages && typeof simplePages === "object") {
      [simplePages.shared, simplePages[page]].forEach((initializer) => {
        if (typeof initializer !== "function") return;

        try {
          const moduleContext = {
            root,
            page,
            signal,
            gsap: window.gsap,
            ScrollTrigger: window.ScrollTrigger,
            SplitText: window.SplitText,
            lenis,
            setScrollLock,
          };
          if (initializer === simplePages.work) {
            const motion = window.gsap.matchMedia();
            motion.add("(prefers-reduced-motion: no-preference)", () => initializer(moduleContext));
            cleanupTasks.push(() => motion.revert());
            return;
          }
          const cleanup = initializer(moduleContext);

          if (typeof cleanup === "function") cleanupTasks.push(cleanup);
        } catch (error) {
          console.error(`Flight3: the ${page || "shared"} page initializer failed.`, error);
        }
      });
    }

    registeredPageModules.forEach((module) => {
      if (module.page !== "*" && module.page !== page) return;

      try {
        const cleanup = module.mount({
          root,
          page,
          signal,
          gsap: window.gsap,
          ScrollTrigger: window.ScrollTrigger,
          SplitText: window.SplitText,
          lenis,
          setScrollLock,
        });

        if (typeof cleanup === "function") cleanupTasks.push(cleanup);
      } catch (error) {
        console.error("Flight3: a page module failed to mount.", error);
      }
    });
  }

  function mountPage(container) {
    const abortController = new AbortController();
    const cleanupTasks = [];
    const styleRecords = new Map();
    const root = container.querySelector(CONFIG.pageSelector) || container;

    // Context owns synchronous setup animations. Event-created timelines still
    // keep their explicit module cleanup because they are created later.
    const context = window.gsap.context(() => {
      initThemeTracking(root, cleanupTasks);
      initSectionParallax(root, cleanupTasks, styleRecords);
      const motion = window.gsap.matchMedia();
      motion.add("(prefers-reduced-motion: no-preference)", () => {
        const splits = [];
        initSplitHeadings(root, splits);
        initGroupAnimations(root);
        initScrollGroups(root);
        return () => splits.forEach((split) => split.revert());
      });
      cleanupTasks.push(() => motion.revert());
      if (!claimPreparedUkiyo(container, cleanupTasks)) {
        initUkiyo(root, abortController.signal, cleanupTasks);
      }
      mountRegisteredModules(root, abortController.signal, cleanupTasks);
    }, root);

    return () => {
      abortController.abort();
      cleanupTasks.reverse().forEach((cleanup) => {
        try {
          cleanup();
        } catch (error) {
          console.warn("Flight3: page cleanup failed.", error);
        }
      });
      context.revert();
      restoreStyles(styleRecords);
    };
  }

  function initDynamicCursorOnce() {
    if (!finePointer.matches) return;

    const cursor = document.querySelector("[data-cursor]");
    if (!cursor) return;

    const textTarget = document.querySelector("[data-cursor-text-target]");
    let mouseX = 0;
    let mouseY = 0;
    let hasMoved = false;
    let ticking = false;
    let currentHover = null;
    let currentState = null;
    let currentText = null;
    let pointerHover = null;
    let needsHitTest = false;
    let cursorRightOffset = 0;
    let cursorGeometryDirty = true;

    const xTo = window.gsap.quickTo(cursor, "x", {
      duration: 0.4,
      ease: "power3.out",
    });
    const yTo = window.gsap.quickTo(cursor, "y", {
      duration: 0.4,
      ease: "power3.out",
    });

    const measureCursorGeometry = () => {
      const rect = cursor.getBoundingClientRect();
      const currentX = parseFloat(window.gsap.getProperty(cursor, "x")) || 0;
      cursorRightOffset = rect.right - currentX;
      cursorGeometryDirty = false;
    };

    const update = () => {
      ticking = false;
      const hover = needsHitTest ? document.elementFromPoint(mouseX, mouseY)?.closest("[data-cursor-hover]") || null : pointerHover;
      needsHitTest = false;

      if (cursorGeometryDirty) measureCursorGeometry();
      const currentX = parseFloat(window.gsap.getProperty(cursor, "x")) || 0;
      const nextState = hover ? (currentX + cursorRightOffset >= window.innerWidth ? "active-edge" : "active") : "";

      if (nextState !== currentState) {
        cursor.setAttribute("data-cursor", nextState);
        currentState = nextState;
        /* The state may change the cursor's size. Measure once on the next
           frame instead of forcing a layout read on every mousemove. */
        cursorGeometryDirty = true;
      }

      if (hover && hover !== currentHover && textTarget) {
        const text = hover.getAttribute("data-cursor-text");
        if (text && text !== currentText) {
          textTarget.textContent = text;
          currentText = text;
        }
      }

      currentHover = hover;
    };

    const requestUpdate = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    };

    window.addEventListener(
      "mousemove",
      (event) => {
        mouseX = event.clientX;
        mouseY = event.clientY;
        hasMoved = true;
        pointerHover = event.target?.closest?.("[data-cursor-hover]") || null;
        xTo(mouseX);
        yTo(mouseY);
        requestUpdate();
      },
      { passive: true },
    );

    window.addEventListener(
      "scroll",
      () => {
        if (hasMoved) {
          needsHitTest = true;
          requestUpdate();
        }
      },
      { passive: true },
    );

    window.addEventListener(
      "resize",
      () => {
        cursorGeometryDirty = true;
        if (hasMoved) requestUpdate();
      },
      { passive: true },
    );
  }

  function initPersistentFormPanel() {
    const backdropSelector = "[data-form-backdrop], [data-contact-panel-backdrop]";
    const dialogSelector = "[data-form-dialog], [data-contact-panel-dialog]";
    const candidates = [...document.querySelectorAll("[data-form-panel]"), ...document.querySelectorAll("[data-contact-panel]")].filter(
      (panel, index, panels) => panels.indexOf(panel) === index,
    );

    /*
     * Prefer a complete data-form-panel. A stale/empty legacy
     * data-contact-panel must not disable the valid form that follows it.
     */
    const panel = candidates.find((candidate) => candidate.querySelector(backdropSelector) && candidate.querySelector(dialogSelector));
    if (!panel) {
      if (candidates.length) {
        console.warn("Flight3: a form panel was found, but it needs a backdrop and dialog child.");
      }
      return null;
    }

    const backdrop = panel.querySelector(backdropSelector);
    const dialog = panel.querySelector(dialogSelector);

    let lastFocused = null;
    let isOpen = false;
    let timeline = null;
    let lockedScrollY = 0;

    const focusTrap = createFlight3FocusTrap(panel);
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    if (!dialog.hasAttribute("tabindex")) dialog.setAttribute("tabindex", "-1");

    const finishClosed = () => {
      isOpen = false;
      panel.classList.remove("is-open");
      panel.setAttribute("aria-hidden", "true");
      panel.inert = true;
      document.documentElement.classList.remove("has-form-panel-open");
      document.documentElement.classList.remove("has-contact-panel-open");
      document.documentElement.removeAttribute("data-form-panel-open");
      setScrollLock("form-panel", false);
      focusTrap.deactivate();
      window.gsap.set([backdrop, dialog], { clearProps: "willChange" });

      if (Math.abs(window.scrollY - lockedScrollY) > 1) {
        if (lenis?.scrollTo) {
          lenis.scrollTo(lockedScrollY, { immediate: true, force: true });
        } else {
          window.scrollTo(0, lockedScrollY);
        }
      }

      lastFocused?.focus?.({ preventScroll: true });
      lastFocused = null;
    };

    const close = ({ immediate = false } = {}) => {
      if (!isOpen && !panel.classList.contains("is-open")) return;
      timeline?.kill();

      if (immediate || reducedMotion.matches) {
        window.gsap.set([backdrop, dialog], { autoAlpha: 0 });
        finishClosed();
        return;
      }

      timeline = window.gsap.timeline({
        onComplete: finishClosed,
      });
      timeline
        .to(
          dialog,
          {
            y: 32,
            autoAlpha: 0,
            duration: 0.4,
            ease: "power3.in",
            overwrite: true,
          },
          0,
        )
        .to(
          backdrop,
          {
            autoAlpha: 0,
            duration: 0.32,
            ease: "power2.inOut",
            overwrite: true,
          },
          0.06,
        );
    };

    const open = (trigger) => {
      mobileNavController?.close?.({ immediate: true });
      if (isOpen) return;
      lastFocused = trigger || document.activeElement;
      lockedScrollY = window.scrollY;
      isOpen = true;
      setScrollLock("form-panel", true);
      panel.classList.add("is-open");
      panel.setAttribute("aria-hidden", "false");
      panel.inert = false;
      document.documentElement.classList.add("has-form-panel-open");
      document.documentElement.setAttribute("data-form-panel-open", "");
      focusTrap.activate();
      timeline?.kill();
      window.gsap.set(backdrop, { willChange: "opacity" });
      window.gsap.set(dialog, { willChange: "transform, opacity" });

      if (reducedMotion.matches) {
        window.gsap.set(backdrop, { autoAlpha: 1 });
        window.gsap.set(dialog, { y: 0, autoAlpha: 1 });
        dialog?.focus?.({ preventScroll: true });
        return;
      }

      timeline = window.gsap.timeline({
        onComplete: () => dialog?.focus?.({ preventScroll: true }),
      });
      timeline
        .set(backdrop, { autoAlpha: 0 })
        .set(dialog, { y: 32, autoAlpha: 0 }, 0)
        .to(
          backdrop,
          {
            autoAlpha: 1,
            duration: 0.42,
            ease: "power2.out",
            overwrite: true,
          },
          0,
        )
        .to(
          dialog,
          {
            y: 0,
            autoAlpha: 1,
            duration: 0.65,
            ease: "power4.out",
            overwrite: true,
          },
          0.05,
        );
    };

    document.addEventListener("click", (event) => {
      const opener = event.target.closest?.("[data-form-open], [data-contact-panel-open]");
      if (opener) {
        event.preventDefault();
        open(opener);
        return;
      }

      const closeControl = event.target.closest?.(
        "[data-form-close], [data-contact-panel-close], [data-form-backdrop], [data-contact-panel-backdrop]",
      );
      if (closeControl || event.target === panel) {
        event.preventDefault();
        close();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (!isOpen) return;

      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
    });

    panel.setAttribute("aria-hidden", "true");
    panel.inert = true;
    panel.classList.remove("is-open");
    window.gsap.set(panel, { clearProps: "display,opacity,visibility" });
    window.gsap.set([backdrop, dialog], { autoAlpha: 0 });
    document.documentElement.setAttribute("data-flight3-form-panel", "ready");

    return {
      open,
      close,
      get isOpen() {
        return isOpen;
      },
    };
  }

  function introIsDue() {
    try {
      return sessionStorage.getItem(CONFIG.introKey) !== "true";
    } catch (error) {
      return false;
    }
  }

  function markIntroComplete() {
    try {
      sessionStorage.setItem(CONFIG.introKey, "true");
    } catch (error) {
      // Storage failure must not block the page.
    }
  }

  function getIntroLottieAnimation(element) {
    if (!element) return null;
    if (element.__flight3IntroLottie) return element.__flight3IntroLottie;

    try {
      const library = window.Webflow?.require?.("lottie")?.lottie;
      const animations = library?.getRegisteredAnimations?.() || [];

      return (
        animations.find((animation) => {
          const wrapper = animation?.wrapper;
          return Boolean(wrapper && (wrapper === element || element.contains(wrapper) || wrapper.contains?.(element)));
        }) || null
      );
    } catch (error) {
      return null;
    }
  }

  function createIntroLottieAnimation(element) {
    if (!element) return null;
    if (element.__flight3IntroLottie) return element.__flight3IntroLottie;

    const source = element.getAttribute("data-src");
    const library = window.lottie;
    if (!source || typeof library?.loadAnimation !== "function") return null;

    try {
      const animation = library.loadAnimation({
        container: element,
        renderer: element.getAttribute("data-renderer") || "svg",
        loop: false,
        autoplay: false,
        path: source,
        rendererSettings: {
          preserveAspectRatio: element.getAttribute("data-preserve-aspect-ratio") || "xMidYMid meet",
        },
      });

      element.__flight3IntroLottie = animation;
      return animation;
    } catch (error) {
      console.warn("Flight3: the intro Lottie could not be created.", error);
      return null;
    }
  }

  function destroyOwnedIntroLottie(element) {
    const animation = element?.__flight3IntroLottie;
    if (!animation) return;

    animation.destroy?.();
    delete element.__flight3IntroLottie;
  }

  async function waitForIntroLottie(element, signal, timeout = 4000) {
    const deadline = performance.now() + timeout;
    let animation = getIntroLottieAnimation(element) || createIntroLottieAnimation(element);

    while (!signal?.aborted && !animation && performance.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 50));
      if (signal?.aborted) return null;
      animation = getIntroLottieAnimation(element) || createIntroLottieAnimation(element);
    }

    if (signal?.aborted) return null;
    if (!animation || animation.isLoaded) return animation;

    const remaining = Math.max(0, deadline - performance.now());
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        animation.removeEventListener?.("DOMLoaded", finish);
        animation.removeEventListener?.("data_failed", finish);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = window.setTimeout(finish, remaining);

      animation.addEventListener?.("DOMLoaded", finish);
      animation.addEventListener?.("data_failed", finish);
      signal?.addEventListener("abort", finish, { once: true });
    });

    return !signal?.aborted && animation.isLoaded ? animation : null;
  }

  async function playIntroLottie(element, signal) {
    const animation = await waitForIntroLottie(element, signal);
    if (signal?.aborted) return false;
    if (!animation) {
      console.warn("Flight3: the intro Lottie was not registered or did not finish loading.");
      return false;
    }

    const authoredDuration = numericAttribute(element, "data-default-duration", CONFIG.introLottieDuration);
    const fallbackDuration = Math.max(CONFIG.introLottieDuration, authoredDuration) + 0.6;

    animation.loop = false;
    animation.setDirection?.(1);
    animation.setSpeed?.(1);
    animation.goToAndStop?.(0, true);

    const completed = await new Promise((resolve) => {
      let settled = false;
      const finish = (completed = false) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        animation.removeEventListener?.("complete", complete);
        signal?.removeEventListener("abort", abort);
        resolve(completed);
      };
      const complete = () => finish(true);
      const abort = () => finish(false);
      const timer = window.setTimeout(abort, fallbackDuration * 1000);

      animation.addEventListener?.("complete", complete);
      signal?.addEventListener("abort", abort, { once: true });
      animation.play?.();
    });

    if (signal?.aborted) animation.pause?.();
    return completed && !signal?.aborted;
  }

  async function playInitialEntrance(container, signal) {
    const entrance = preparePageEntrance(container);
    let exit = null;
    const intro = document.querySelector("[data-site-intro]");
    const lottieElement = intro?.querySelector("[data-site-intro-lottie]");
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      entrance.timeline.kill();
      exit?.kill();
      entrance.cleanup();
      getIntroLottieAnimation(lottieElement)?.pause?.();
      if (currentHeroCleanup === cleanup) currentHeroCleanup = null;
      document.documentElement.classList.remove("is-intro-pending", "is-intro-playing");
      if (intro) window.gsap.set(intro, { clearProps: "clipPath,opacity,visibility,willChange" });
      setDocumentBusy(false);
      setScrollLock("intro", false);
    };
    currentHeroCleanup = cleanup;
    signal.addEventListener("abort", cleanup, { once: true });

    document.documentElement.classList.remove("is-transition-preparing");

    if (reducedMotion.matches) {
      document.documentElement.classList.remove("is-intro-pending");
      cleanup();
      signal.removeEventListener("abort", cleanup);
      return;
    }

    if (!introIsDue()) {
      await nextPaint();
      if (signal.aborted) return;
      entrance.timeline.play(0);
      await animationPromise(entrance.timeline, signal);
      signal.removeEventListener("abort", cleanup);
      cleanup();
      return;
    }

    setScrollLock("intro", true);
    setDocumentBusy(true);

    try {
      if (!intro || !lottieElement) {
        console.warn("Flight3: the intro needs [data-site-intro] and [data-site-intro-lottie].");
        document.documentElement.classList.remove("is-intro-pending");
        entrance.timeline.play(0);
        await animationPromise(entrance.timeline, signal);
        return;
      }

      entrance.timeline.pause(0);
      window.gsap.set(intro, {
        autoAlpha: 1,
        clipPath: "inset(0% 0% 0% 0%)",
        willChange: "clip-path",
      });
      document.documentElement.classList.add("is-intro-playing");
      await nextPaint();
      if (signal.aborted) return;

      const lottiePlayed = await playIntroLottie(lottieElement, signal);
      if (signal.aborted) return;
      exit = window.gsap.to(intro, {
        clipPath: "inset(0% 0% 100% 0%)",
        duration: CONFIG.introExitDuration,
        ease: getTransitionEase(),
      });
      await animationPromise(exit, signal);
      if (signal.aborted) return;

      if (lottiePlayed) markIntroComplete();

      document.documentElement.classList.remove("is-intro-pending", "is-intro-playing");
      window.gsap.set(intro, { autoAlpha: 0 });

      entrance.timeline.play(0);
      await animationPromise(entrance.timeline, signal);
    } finally {
      signal.removeEventListener("abort", cleanup);
      cleanup();
      destroyOwnedIntroLottie(lottieElement);
    }
  }

  function shouldIgnoreVisit(url, { el } = {}) {
    if (!el) return false;
    if (el.closest("[data-no-swup], [data-transition-skip], [data-form-open], [data-contact-panel-open]")) {
      return true;
    }

    const anchor = el.closest("a[href]");
    if (!anchor) return true;
    if (anchor.hasAttribute("download")) return true;

    const target = (anchor.getAttribute("target") || "").toLowerCase();
    if (target && target !== "_self") return true;

    const rawHref = anchor.getAttribute("href");
    if (!rawHref || rawHref.startsWith("#")) return true;

    let destination;
    try {
      destination = new URL(rawHref, window.location.href);
    } catch (error) {
      return true;
    }

    if (!/^https?:$/.test(destination.protocol)) return true;
    if (destination.origin !== window.location.origin) return true;
    if (NON_HTML_EXTENSION.test(destination.pathname)) return true;

    const current = new URL(window.location.href);
    const sameDocument = destination.pathname === current.pathname && destination.search === current.search;

    if (sameDocument) return true;
    return false;
  }

  function cleanupOldPageOnce(visit) {
    if (cleanedVisitId === visit.id) return;
    cleanedVisitId = visit.id;
    const { previous } = getParallelContainers();
    if (previous) cleanupRouteForms(previous);
    currentPageCleanup?.();
    currentPageCleanup = null;
  }

  function restoreAfterInterruptedVisit(visit) {
    if (visit?.id != null && currentVisit?.id !== visit.id) return;
    lifecycleController.abort();
    activeTransition?.kill?.();
    activeTransition = null;
    currentHeroCleanup?.();
    currentHeroCleanup = null;
    cleanupPreparedUkiyo();
    resetTransitionPresentation();
    document.documentElement.classList.remove("is-transitioning");
    setDocumentBusy(false);
    setScrollLock("transition", false);
    syncWebflowCurrentLinks();
    window.Flight3Consent?.abortNavigation();

    if (!currentPageCleanup) {
      const container = document.querySelector(CONFIG.routerSelector);
      if (container) currentPageCleanup = mountPage(container);
    }
  }

  function shouldResetVisitScroll(visit) {
    return Boolean(visit && !visit.history?.popstate && !visit.to?.hash);
  }

  function resetScrollPosition() {
    if (lenis?.scrollTo) {
      lenis.scrollTo(0, { immediate: true, force: true });
    }

    /* Keep native scroll and Lenis' internal target in agreement. Safari can
       otherwise restore the old route position after the fixed page unlocks. */
    window.scrollTo(0, 0);
    const scrollingElement = document.scrollingElement;
    if (scrollingElement) scrollingElement.scrollTop = 0;
    if (document.body) document.body.scrollTop = 0;
  }

  function scrollAfterVisit(visit, container) {
    if (visit.history?.popstate) return;

    const hash = visit.to?.hash;
    if (hash) {
      let target = null;
      try {
        target = container.querySelector(hash);
      } catch (error) {
        target = null;
      }

      if (target) {
        if (lenis?.scrollTo) {
          lenis.scrollTo(target, { immediate: true, force: true });
        } else {
          target.scrollIntoView();
        }
        return;
      }
    }

    resetScrollPosition();
  }

  function createRouter() {
    if (
      typeof window.Swup === "undefined" ||
      typeof window.SwupParallelPlugin === "undefined" ||
      typeof window.SwupJsPlugin === "undefined"
    ) {
      console.error("Flight3: Swup or a required Swup plugin is missing.");
      return null;
    }

    const plugins = [
      new window.SwupParallelPlugin({ containers: [CONFIG.routerSelector] }),
      new window.SwupJsPlugin({
        animations: [
          {
            from: "(.*)",
            to: "(.*)",
            out: () => Promise.resolve(),
            in: () => playParallelTransition(),
          },
        ],
      }),
    ];

    if (typeof window.SwupHeadPlugin !== "undefined") {
      plugins.push(
        new window.SwupHeadPlugin({
          awaitAssets: true,
          attributes: ["lang", "dir", "data-wf-page", "data-wf-collection", "data-wf-item-slug"],
        }),
      );
    }

    if (typeof window.SwupA11yPlugin !== "undefined") {
      plugins.push(
        new window.SwupA11yPlugin({
          respectReducedMotion: true,
          autofocus: false,
        }),
      );
    }

    const instance = new window.Swup({
      containers: [CONFIG.routerSelector],
      plugins,
      cache: true,
      timeout: 12000,
      animateHistoryBrowsing: false,
      animationSelector: "[data-swup-animation-target]",
      ignoreVisit: shouldIgnoreVisit,
    });

    instance.hooks.on("visit:start", (visit) => {
      window.Flight3Consent?.beginNavigation();
      lifecycleController.abort();
      lifecycleController = new AbortController();
      document.documentElement.classList.remove("is-transition-preparing", "is-intro-pending", "is-intro-playing");
      currentVisit = visit;
      cleanedVisitId = null;
      currentHeroCleanup?.();
      currentHeroCleanup = null;
      cleanupPreparedUkiyo();
      mobileNavController?.close?.({ immediate: true });
      formPanelController?.close?.({ immediate: true });
      setDocumentBusy(true);
      setScrollLock("transition", true);
      document.documentElement.classList.add("is-transitioning");

      // Preserve the outgoing scroll position during the overlap. We perform
      // the new-page scroll only after the incoming panel fully covers it.
      if (!visit.history?.popstate) visit.scroll.reset = false;
    });

    instance.hooks.before("content:insert", (visit, { containers } = {}) => {
      updateWebflowPageId(visit);
      syncWebflowCurrentLinks(visit?.to?.url);

      if (!visit.animation?.animate || reducedMotion.matches) return;

      const set = containers?.find?.((entry) => entry.selector === CONFIG.routerSelector);
      const next = set?.next;
      if (!next) return;

      next.setAttribute("data-flight3-next", "");
      next.style.visibility = "hidden";
    });

    // With Parallel Plugin the outgoing page remains visible until removal.
    // Reverting it at content:replace exposes scroll-hidden hero content.
    instance.hooks.before("content:remove", cleanupOldPageOnce);

    instance.hooks.on("visit:end", async (visit) => {
      if (currentVisit !== visit) return;
      const signal = lifecycleController.signal;
      // The Head Plugin may remove a runtime fallback style that is not part
      // of the fetched document. Restore it for the next route as a safeguard.
      ensureTransitionStyles();
      const container = document.querySelector(CONFIG.routerSelector);

      activeTransition = null;
      resetTransitionPresentation();

      /* Mobile browsers may ignore scrollTo while the document is
         overflow-locked, then restore the outgoing page's scroll position. */
      document.documentElement.classList.remove("is-transitioning");
      setDocumentBusy(false);
      setScrollLock("transition", false);
      scrollAfterVisit(visit, container);
      syncInitialNavTheme(container, { atScroll: true });

      const functionalReady = await reinitializeWebflow(container);
      if (functionalReady === false) return;
      if (signal.aborted || currentVisit !== visit || !container?.isConnected) return;

      syncWebflowCurrentLinks();
      currentPageCleanup = mountPage(container);
      // Theme triggers have selected the active section, including restored history scroll.
      refreshScrollSystems();

      /* Webflow modules, SplitText and ScrollTrigger can all change layout
         during their first refresh. Reassert a normal route's top position
         after those measurements settle. Hash and popstate visits retain
         their intended browser positions. */
      await nextPaint();
      if (signal.aborted || currentVisit !== visit) return;
      scrollAfterVisit(visit, container);
      syncInitialNavTheme(container, { atScroll: true });
      currentVisit = null;
      window.Flight3Consent?.completeNavigation();
    });

    instance.hooks.on("visit:abort", restoreAfterInterruptedVisit);
    instance.hooks.on("fetch:error", restoreAfterInterruptedVisit);
    instance.hooks.on("fetch:timeout", restoreAfterInterruptedVisit);

    return instance;
  }

  api.registerPageModule = (pageOrModule, maybeFactory) => {
    const module = normalizePageModule(pageOrModule, maybeFactory);
    if (!module) {
      throw new TypeError("Flight3.registerPageModule expects a function, a page name plus function, or { page, mount }.");
    }

    registeredPageModules.add(module);
    return () => registeredPageModules.delete(module);
  };

  api.refresh = refreshScrollSystems;
  api.openFormPanel = (trigger) => formPanelController?.open?.(trigger);
  api.closeFormPanel = () => formPanelController?.close?.();
  /* Backwards-compatible aliases for the earlier contact-panel API. */
  api.openContactPanel = api.openFormPanel;
  api.closeContactPanel = api.closeFormPanel;

  async function init() {
    if (typeof window.gsap === "undefined" || typeof window.ScrollTrigger === "undefined") {
      document.documentElement.classList.remove("is-transition-preparing", "is-intro-pending");
      console.error("Flight3: GSAP and ScrollTrigger are required.");
      return;
    }

    window.gsap.registerPlugin(window.ScrollTrigger);
    if (typeof window.SplitText !== "undefined") {
      window.gsap.registerPlugin(window.SplitText);
    } else {
      console.error(
        "Flight3: SplitText is missing. Load SplitText.min.js after GSAP and before Slater 65135; text and Home hero interactions require it.",
      );
    }
    if (typeof window.Flip !== "undefined") {
      window.gsap.registerPlugin(window.Flip);
    }
    if (typeof window.CustomEase !== "undefined") {
      window.gsap.registerPlugin(window.CustomEase);
      transitionEase = window.CustomEase.create("flight3-transition-snap", "0.83, 0, 0.17, 1");
    }

    window.ScrollTrigger.config({ ignoreMobileResize: true });

    const initialContainer = document.querySelector(CONFIG.routerSelector);
    if (!initialContainer) {
      document.documentElement.classList.remove("is-transition-preparing", "is-intro-pending");
      console.error("Flight3: #swup was not found.");
      return;
    }

    initLenisOnce();
    try {
      api.consent = initFlight3Consent({ gsap: window.gsap, setScrollLock });
    } catch (error) {
      console.error("Flight3: consent could not initialize; site navigation continues.", error);
    }
    namespaceDuplicateFormIds(document);
    captureNativeFormHandlers();
    initDynamicCursorOnce();
    mobileNavController = initMobileNavOnce();
    formPanelController = initPersistentFormPanel();
    swup = createRouter();
    api.swup = swup;

    syncInitialNavTheme(initialContainer);
    syncWebflowCurrentLinks();
    const signal = lifecycleController.signal;
    await waitForEntranceMedia(initialContainer, signal);
    if (signal.aborted || !initialContainer.isConnected) return;
    prepareIncomingUkiyo(initialContainer);
    await playInitialEntrance(initialContainer, signal);
    if (signal.aborted || !initialContainer.isConnected) return;
    currentPageCleanup = mountPage(initialContainer);
    setScrollLock("transition", false);
    refreshScrollSystems();
    api.consent?.ready();
  }

  window.Webflow = window.Webflow || [];
  window.Webflow.push(init);
})();
