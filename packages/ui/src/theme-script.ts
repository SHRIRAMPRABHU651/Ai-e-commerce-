/* Server-safe (no 'use client'): imported by the root layout. */
export const THEME_KEY = 'orvia_theme';

/** Tiny pre-paint script (inline in the root layout). Safe when storage is blocked; otherwise the OS preference applies via CSS. */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_KEY}');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}})();`;
