/**
 * The location drawings, shared by the library and the bench kiosk (/kiosk) so
 * a place looks the same on both screens.
 */

/**
 * Drawings for the places filament lives.
 *
 * Kept deliberately few and deliberately blunt. The point of an icon here is
 * to be told apart from the one under it at a glance while a thumb is moving,
 * not to be a picture of your actual shelf — so these are silhouettes with no
 * interior detail, and there are a dozen rather than fifty.
 */
export const LOCATION_ICONS = {
  printer: '<path d="M7 9V4h10v5M7 17v3h10v-3M5 9h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z"/>',
  drybox:  '<path d="M4 8h16v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8zM3 5h18v3H3zM10 13h4"/>',
  shelf:   '<path d="M3 4h18M3 12h18M3 20h18M7 4v8M17 12v8"/>',
  box:     '<path d="M4 8l8-4 8 4v9l-8 4-8-4V8zM4 8l8 4 8-4M12 12v9"/>',
  drawer:  '<path d="M4 4h16v16H4zM4 12h16M9 8h6M9 16h6"/>',
  bin:     '<path d="M5 7h14l-1 13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 7zM9 4h6v3H9z"/>',
  bag:     '<path d="M6 8h12l-1 12H7L6 8zM9 8V5a3 3 0 0 1 6 0v3"/>',
  cabinet: '<path d="M5 3h14v18H5zM12 3v18M9 11h1M14 11h1"/>',
  /*
   * The same cabinet with one door filled in, rather than one door drawn ajar.
   *
   * The first attempt mirrored an open door and was a failure: at this size two
   * mirrored outlines are the same amount of ink in nearly the same places, and
   * you had to work out which was which instead of seeing it. A solid block on
   * one side is not subtle, which is the entire requirement — these exist to
   * tell two cabinets standing next to each other apart across a room.
   */
  'cabinet-left':  '<path d="M5 3h14v18H5zM12 3v18M15.5 11v2"/>'
                 + '<path d="M6.3 4.3h4.4v15.4H6.3z" fill="currentColor" stroke="none"/>',
  'cabinet-right': '<path d="M5 3h14v18H5zM12 3v18M8.5 11v2"/>'
                 + '<path d="M13.3 4.3h4.4v15.4h-4.4z" fill="currentColor" stroke="none"/>',
  cart:    '<path d="M4 5h3l2 10h9M6 19a1.6 1.6 0 1 0 3 0 1.6 1.6 0 1 0-3 0M15 19a1.6 1.6 0 1 0 3 0 1.6 1.6 0 1 0-3 0M9 11h11l1-5H8"/>',
  desk:    '<path d="M3 9h18M4 9v11M20 9v11M4 5h16v4H4zM9 13h6"/>',
  closet:  '<path d="M4 3h16v18H4zM4 9h16M12 5v2M9 15h6"/>',
  wall:    '<path d="M3 6h7v5H3zM14 6h7v5h-7zM8 13h8v5H8z"/>',
};

/** Every icon a person can choose from, printers first since those lead the list. */
export const ICON_CHOICES = ['printer', 'drybox', 'shelf', 'box', 'drawer', 'bin',
  'bag', 'cabinet', 'cabinet-left', 'cabinet-right', 'cart', 'desk', 'closet', 'wall'];

export function locIconSVG(key) {
  const path = LOCATION_ICONS[key] ?? LOCATION_ICONS.box;
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
}
