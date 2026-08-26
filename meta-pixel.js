/* Huggy marketing measurement. Do not pass emails, phone numbers, or auth tokens. */
(function loadMetaPixel(window, document) {
  if (window.fbq) return;
  const pixelId = '1064168139334556';
  const fbq = window.fbq = function () {
    if (fbq.callMethod) fbq.callMethod.apply(fbq, arguments);
    else fbq.queue.push(arguments);
  };
  if (!window._fbq) window._fbq = fbq;
  fbq.push = fbq;
  fbq.loaded = true;
  fbq.version = '2.0';
  fbq.queue = [];
  const script = document.createElement('script');
  script.async = true;
  script.src = 'https://connect.facebook.net/en_US/fbevents.js';
  const firstScript = document.getElementsByTagName('script')[0];
  firstScript.parentNode.insertBefore(script, firstScript);
  fbq('init', pixelId);
  fbq('track', 'PageView');
})(window, document);
