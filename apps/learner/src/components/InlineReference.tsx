import React from "react";
import { Text } from "react-native";
export interface InlineReferenceProps {
  label: string;
  href: string;
}
export function InlineReference({ label }: InlineReferenceProps) {
  return <Text>{label}</Text>;
}
