import { createContext, useContext } from "react";
import { Pressable, Text, View, PlatformColor, type TextProps } from "react-native";
import { SymbolView, type SymbolViewProps } from "expo-symbols";

export const c = {
  ink: PlatformColor("label"), sub: PlatformColor("secondaryLabel"), accent: PlatformColor("systemBlue"),
  page: PlatformColor("systemBackground"), group: PlatformColor("secondarySystemBackground"),
  line: PlatformColor("separator"), green: PlatformColor("systemGreen"), danger: PlatformColor("systemRed"),
  orange: PlatformColor("systemOrange"),
};
export function Label({ style, ...props }: TextProps) {
  return <Text style={[{ color: c.ink, fontSize: 17 }, style]} {...props} />;
}
export function Caption({ children }: { children: React.ReactNode }) {
  return <Label style={{ fontSize: 14, color: c.sub }}>{children}</Label>;
}
// Bar items stay on one line, like UIKit's, so the largest text sizes can't break "Cancel" into "Ca / nc / el".
const BAR_SCALE = 1.35;
const InBar = createContext(false);
export function Bar({ children }: { children: React.ReactNode }) {
  return <InBar.Provider value>{children}</InBar.Provider>;
}
export function Heading({ children }: { children: React.ReactNode }) {
  // Large titles stop growing before a single word is wider than the screen.
  return <Label accessibilityRole="header" maxFontSizeMultiplier={1.6} style={{ fontSize: 34, fontWeight: "700",
    letterSpacing: -1, marginBottom: 6 }}>{children}</Label>;
}
export function Symbol({ name, size = 21, color = c.accent }: {
  name: SymbolViewProps["name"]; size?: number; color?: SymbolViewProps["tintColor"];
}) {
  return <SymbolView accessible={false} accessibilityElementsHidden name={name} size={size} tintColor={color} style={{ width: size, height: size }} />;
}
export function Action({ label, spoken, icon, press, primary, disabled, iconOnly }: {
  label: string; spoken?: string; icon?: SymbolViewProps["name"]; press(): void;
  primary?: boolean; disabled?: boolean; iconOnly?: boolean;
}) {
  const bar = useContext(InBar);
  return <Pressable accessibilityRole="button" accessibilityLabel={spoken ?? label} disabled={disabled}
    accessibilityState={{ disabled: !!disabled }} onPress={press}
    style={({ pressed }) => ({ minHeight: 44, minWidth: 44, maxWidth: bar ? "100%" : undefined, borderRadius: 14, paddingHorizontal: iconOnly ? 8 : 12,
      backgroundColor: primary ? c.accent : "transparent", opacity: pressed || disabled ? 0.55 : 1,
      alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 })}>
    {icon && <Symbol name={icon} color={primary ? "white" : c.accent} />}
    {!iconOnly && <Label {...bar && { numberOfLines: 1, maxFontSizeMultiplier: BAR_SCALE, adjustsFontSizeToFit: true, minimumFontScale: 0.7 }}
      style={{ fontWeight: "600", color: primary ? "white" : c.accent, flexShrink: 1 }}>{label}</Label>}
  </Pressable>;
}
/** An iOS navigation bar: a centred title with optional leading and trailing controls. */
export function NavBar({ title, leading, trailing }: {
  title: string; leading?: React.ReactNode; trailing?: React.ReactNode;
}) {
  return <View style={{ minHeight: 48, flexDirection: "row", alignItems: "center", paddingHorizontal: 8,
    borderBottomWidth: 0.5, borderColor: c.line }}>
    <View style={{ flex: 1, alignItems: "flex-start" }}><Bar>{leading}</Bar></View>
    <Label accessibilityRole="header" numberOfLines={1} maxFontSizeMultiplier={BAR_SCALE}
      style={{ fontSize: 17, fontWeight: "600", maxWidth: "50%" }}>{title}</Label>
    <View style={{ flex: 1, alignItems: "flex-end" }}><Bar>{trailing}</Bar></View>
  </View>;
}
/** A small coloured dot that says at a glance whether the link to the Mac is up. */
export function StatusDot({ status }: { status: string }) {
  const color = status === "Live" ? c.green : ["Refused", "Pairing expired", "Host stopped sharing"].includes(status)
    ? c.danger : c.orange;
  return <View accessible={false} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}
export function Warning({ secure }: { secure: boolean }) {
  return <Caption>{secure ? "Encrypted on private Wi-Fi" : "Unencrypted link · Trusted Wi-Fi only"}</Caption>;
}

export function ToolbarAction({ label, icon, press, primary, disabled, checked }: {
  label: string; icon: SymbolViewProps["name"]; press(): void;
  primary?: boolean; disabled?: boolean; checked?: boolean;
}) {
  const color = primary ? "white" : checked === false ? c.sub : c.accent;
  return <Pressable accessibilityRole={checked === undefined ? "button" : "switch"} accessibilityLabel={label}
    accessibilityState={{ disabled: !!disabled, ...(checked === undefined ? {} : { checked }) }} disabled={disabled} onPress={press}
    style={({ pressed }) => ({ flex: 1, minWidth: 0, minHeight: 52, borderRadius: 12,
      alignItems: "center", justifyContent: "center", gap: 3, opacity: pressed || disabled ? 0.55 : 1,
      backgroundColor: primary ? c.accent : checked ? c.group : "transparent" })}>
    <Symbol name={icon} size={20} color={color} />
    <Label numberOfLines={1} maxFontSizeMultiplier={1.25} style={{ fontSize: 11, fontWeight: "600", color }}>{label}</Label>
  </Pressable>;
}
export { errorText } from "./errors";
