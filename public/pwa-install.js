/* Registers the service worker and shows a "Install app" button once eligible. */
(function () {
  if ("serviceWorker" in navigator) {
    addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((e) =>
        console.warn("[pwa] sw registration failed:", e)
      );
    });
  }

  let deferred = null;
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    showBanner();
  });

  function showBanner() {
    if (document.getElementById("pwa-install-banner")) return;
    const bar = document.createElement("div");
    bar.id = "pwa-install-banner";
    bar.style.cssText =
      "position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:9999;" +
      "background:#151515;color:#fff;padding:12px 16px;border-radius:8px;display:flex;gap:12px;" +
      "align-items:center;box-shadow:0 10px 30px rgba(0,0,0,.3);font:13px system-ui,sans-serif;";
    const msg = document.createElement("span");
    msg.textContent = "Install Chain SaaS on your device?";
    const yes = document.createElement("button");
    yes.textContent = "Install";
    yes.style.cssText = "background:#a8873a;border:0;color:#fff;padding:8px 14px;border-radius:6px;cursor:pointer;font:inherit;";
    const no = document.createElement("button");
    no.textContent = "Not now";
    no.style.cssText = "background:transparent;border:1px solid #555;color:#eee;padding:8px 14px;border-radius:6px;cursor:pointer;font:inherit;";
    bar.append(msg, yes, no);
    document.body.appendChild(bar);

    yes.onclick = async () => {
      bar.remove();
      if (!deferred) return;
      deferred.prompt();
      await deferred.userChoice;
      deferred = null;
    };
    no.onclick = () => bar.remove();
  }
})();