/**
 * Theme palette and provider.
 *
 * Every screen and component reads its colors from {@link Palette} via
 * {@link useTheme} / {@link useThemedStyles} instead of hardcoding hex, so the
 * app honours the light/dark/system preference. Both palettes mirror the
 * desktop app's CSS custom properties (see `apps/desktop` `styles.css`) so the
 * two clients share one visual identity.
 *
 * Tokens that sit over live video (the call tile name strip) are fixed
 * light-on-dark in both themes for legibility, since the video behind them is
 * theme-independent.
 */

import { createContext, createElement, useContext, useMemo } from "react";
import type { JSX, ReactNode } from "react";

export interface Palette {
  bg: string;
  topbar: string;
  surface: string;
  surfaceRaised: string;
  surfaceTile: string;
  surfaceInput: string;
  avatar: string;
  accentSurface: string;
  accentSurfaceAlt: string;
  border: string;
  borderTile: string;
  borderSoft: string;
  borderInput: string;
  borderStrong: string;
  borderAccent: string;
  textPrimary: string;
  textBright: string;
  textBright2: string;
  textMuted: string;
  textMutedAlt: string;
  textNote: string;
  textFaint: string;
  accent: string;
  accentBright: string;
  onAccent: string;
  dangerSurface: string;
  dangerBorder: string;
  dangerText: string;
  toastText: string;
  danger: string;
  warnSurface: string;
  warnBorder: string;
  scrim: string;
  // Over-video overlay — fixed in both themes for legibility.
  tileScrim: string;
  tileText: string;
  /** Native status-bar content style for this palette. */
  barStyle: "light-content" | "dark-content";
}

export const darkPalette: Palette = {
  bg: "#0c0a18",
  topbar: "#14122a",
  surface: "#14122a",
  surfaceRaised: "#1c1938",
  surfaceTile: "#1c1938",
  surfaceInput: "#1c1938",
  avatar: "#272348",
  accentSurface: "#3a2a70",
  accentSurfaceAlt: "#342f5c",
  border: "#1e1c2a",
  borderTile: "#2b2a37",
  borderSoft: "#1e1c2a",
  borderInput: "#2b2a37",
  borderStrong: "#3d3c49",
  borderAccent: "#5a4a9a",
  textPrimary: "#ecebf6",
  textBright: "#f4f3fb",
  textBright2: "#dcdaee",
  textMuted: "#c5c1dc",
  textMutedAlt: "#8782a5",
  textNote: "#d3cfe6",
  textFaint: "#56536e",
  accent: "#a880ff",
  accentBright: "#c4a6ff",
  onAccent: "#0c0a18",
  dangerSurface: "#3a1d29",
  dangerBorder: "#8f4b63",
  dangerText: "#ffd3dd",
  toastText: "#f7ecf0",
  danger: "#e2607c",
  warnSurface: "#3a2d16",
  warnBorder: "#8b6a2a",
  scrim: "rgba(6,4,16,0.5)",
  tileScrim: "rgba(9,12,11,0.72)",
  tileText: "#f6f7f2",
  barStyle: "light-content",
};

export const lightPalette: Palette = {
  bg: "#f1eef8",
  topbar: "#e8e3f3",
  surface: "#ffffff",
  surfaceRaised: "#ffffff",
  surfaceTile: "#e8e3f3",
  surfaceInput: "#ffffff",
  avatar: "#ddd6ec",
  accentSurface: "#d9c6ff",
  accentSurfaceAlt: "#cbb6f5",
  border: "#dcd5ec",
  borderTile: "#d0c7e3",
  borderSoft: "#dcd5ec",
  borderInput: "#c9bfe0",
  borderStrong: "#beb2d6",
  borderAccent: "#9a73e0",
  textPrimary: "#18132e",
  textBright: "#120e24",
  textBright2: "#2a2444",
  textMuted: "#3e375c",
  textMutedAlt: "#6d647f",
  textNote: "#2f2950",
  textFaint: "#a097b3",
  accent: "#6d3ec4",
  accentBright: "#5a2cb0",
  onAccent: "#ffffff",
  dangerSurface: "#fbe0e6",
  dangerBorder: "#d3899a",
  dangerText: "#7a2535",
  toastText: "#5e1b2a",
  danger: "#c43e5b",
  warnSurface: "#fbeecb",
  warnBorder: "#cfa94f",
  scrim: "rgba(24,19,46,0.32)",
  tileScrim: "rgba(9,12,11,0.72)",
  tileText: "#f6f7f2",
  barStyle: "dark-content",
};

export type ResolvedTheme = "light" | "dark";

export function paletteFor(theme: ResolvedTheme): Palette {
  return theme === "light" ? lightPalette : darkPalette;
}

const ThemeContext = createContext<Palette>(darkPalette);

export function ThemeProvider({
  palette,
  children,
}: {
  palette: Palette;
  children: ReactNode;
}): JSX.Element {
  return createElement(ThemeContext.Provider, { value: palette }, children);
}

export function useTheme(): Palette {
  return useContext(ThemeContext);
}

/**
 * Build a memoized StyleSheet from the active palette. `factory` must be a
 * stable, module-level function so the memo key is just the palette.
 */
export function useThemedStyles<T>(factory: (palette: Palette) => T): T {
  const palette = useTheme();
  return useMemo(() => factory(palette), [palette, factory]);
}
