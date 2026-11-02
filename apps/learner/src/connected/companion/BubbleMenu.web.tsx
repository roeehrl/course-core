import React from "react";
import { useT } from "../../i18n";
import { IconButton } from "../ui/IconButton.web";
import { Menu, type MenuItem } from "../ui/Menu.web";

/**
 * More beside a learner's message (final design §3.7): Copy; "Edit and resend" for the latest
 * question after a stop, a failure, a removal or a question that was not sent; and, after a
 * hairline, "Delete question" in `--danger` (never while the question is in progress).
 */
export function BubbleMenu({ triggerRef, onCopy, onEdit, onDelete }: {
  /** The More button, for the delete confirm to sit at. */
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
  onCopy: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  const t = useT();
  const items: MenuItem[] = [{ id: "copy", label: t("bubbleMenu.copy"), icon: "copy", onSelect: onCopy }];
  if (onEdit) items.push({ id: "edit", label: t("bubbleMenu.edit"), icon: "pencil", onSelect: onEdit });
  if (onDelete) items.push({ id: "delete", label: t("bubbleMenu.delete"), icon: "trash-2", danger: true, onSelect: onDelete });
  return (
    <Menu
      label={t("bubbleMenu.trigger")}
      items={items}
      align="start"
      className="cc-act-menu cc-act-bubble-menu"
      trigger={({ ref, ...props }) => (
        <IconButton
          ref={(node) => {
            ref.current = node;
            if (triggerRef) triggerRef.current = node;
          }}
          icon="more-horizontal"
          iconSize={16}
          className="cc-act-icon cc-act-bubble-more"
          label={t("bubbleMenu.trigger")}
          {...props}
        />
      )}
    />
  );
}
