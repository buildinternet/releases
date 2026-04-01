/**
 * Inline script that runs before paint to set the `dark` class on <html>,
 * preventing a flash of wrong theme. The string is a hardcoded constant
 * with no user input — safe for dangerouslySetInnerHTML.
 */
const THEME_INIT = [
  "(function(){try{",
  "var t=localStorage.getItem('theme');",
  "var d=t==='dark'||(t!=='light'&&window.matchMedia('(prefers-color-scheme:dark)').matches);",
  "if(d)document.documentElement.classList.add('dark')",
  "}catch(e){}})()",
].join("");

export function ThemeScript() {
  return <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />;
}
