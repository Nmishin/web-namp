/** Bootstrap: create the audio engine and hand it to the UI layer. */
import './style.css';
import { Player } from './player';
import { initUI } from './ui';

initUI(new Player());

// Register the PWA service worker. Base-aware (import.meta.env.BASE_URL is "/"
// on the normal build and "/web-namp/" on the GitHub Pages build), so both the
// SW URL and its scope resolve correctly wherever the app is hosted.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`, {
        scope: import.meta.env.BASE_URL,
      })
      .catch((e) => console.warn('[web-namp] SW registration failed:', e));
  });
}
