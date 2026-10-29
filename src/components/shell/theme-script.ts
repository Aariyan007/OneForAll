// Runs inline in <head> before first paint so the saved theme is applied without a flash. Dark unless the person chose light.
export const THEME_KEY = "ofa-theme";
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_KEY}");document.documentElement.dataset.theme=t==="light"?"light":"dark"}catch(e){document.documentElement.dataset.theme="dark"}})();`;
