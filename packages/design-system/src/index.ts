/**
 * @releases/design-system — public surface.
 *
 * Components are thin wrappers over the design's class-string vocabulary; the raw
 * class constants are re-exported from `./classes` for callers that prefer them.
 * Brand tokens live in `./styles.css` (import it once at the app root).
 */

// Class-string vocabulary (the design system's primitives, used by the components).
export * from "./classes";

// Foundations — token reference cards.
export {
  BrandColors,
  ProductPalette,
  SurfaceTokens,
  Typography,
  Radius,
} from "./components/Foundations";

// Actions.
export { Button } from "./components/Button";
export type { ButtonProps, ButtonSize, ButtonVariant } from "./components/Button";

// Forms.
export { Input } from "./components/Input";
export type { InputProps } from "./components/Input";
export { Textarea } from "./components/Textarea";
export type { TextareaProps } from "./components/Textarea";
export { Label } from "./components/Label";
export type { LabelProps } from "./components/Label";
export { Toggle } from "./components/Toggle";
export type { ToggleProps } from "./components/Toggle";

// Layout & containers.
export { Card } from "./components/Card";
export type { CardProps } from "./components/Card";
export { ListCard, ListRow } from "./components/List";
export type { ListCardProps, ListRowProps } from "./components/List";
export { Eyebrow } from "./components/Eyebrow";
export type { EyebrowProps } from "./components/Eyebrow";
export { Aside } from "./components/Aside";
export type { AsideProps } from "./components/Aside";
export { SettingsSection, PanelGrid } from "./components/SettingsSection";
export type { PanelGridProps, SettingsSectionProps } from "./components/SettingsSection";

// Feedback.
export { PreviewBanner, SuccessBanner, ErrorText } from "./components/Banners";
export type { ErrorTextProps, PreviewBannerProps, SuccessBannerProps } from "./components/Banners";

// Theme.
export { ThemeProvider, useTheme } from "./components/ThemeProvider";
export { ThemeToggle } from "./components/ThemeToggle";

// Data viz.
export { Sparkline } from "./components/Sparkline";
export type { SparklineProps } from "./components/Sparkline";
