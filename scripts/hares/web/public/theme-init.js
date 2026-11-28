// Applies the saved theme before the first paint, so a light-theme reader never sees a dark flash.
// The app's ThemeService owns the preference; this only reads it. "system" leaves the attribute off.
try {
  var saved = localStorage.getItem('hares:theme');
  if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
} catch (error) {
  // Storage blocked: follow the device.
}
