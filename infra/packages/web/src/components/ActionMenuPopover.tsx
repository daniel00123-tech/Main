import { useLayoutEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";

export type ActionMenuItem = {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
};

const VIEWPORT_MARGIN = 8;
const TRIGGER_GAP = 4;

function computeMenuPosition(
  trigger: DOMRect,
  menuWidth: number,
  menuHeight: number,
): { top: number; left: number } {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let top = trigger.bottom + TRIGGER_GAP;
  if (top + menuHeight > viewportHeight - VIEWPORT_MARGIN) {
    top = trigger.top - menuHeight - TRIGGER_GAP;
  }
  if (top < VIEWPORT_MARGIN) {
    top = Math.max(VIEWPORT_MARGIN, viewportHeight - menuHeight - VIEWPORT_MARGIN);
  }

  let left = trigger.right - menuWidth;
  if (left < VIEWPORT_MARGIN) {
    left = VIEWPORT_MARGIN;
  }
  if (left + menuWidth > viewportWidth - VIEWPORT_MARGIN) {
    left = viewportWidth - menuWidth - VIEWPORT_MARGIN;
  }

  return { top, left };
}

export function ActionMenuPopover({
  open,
  onClose,
  triggerRef,
  items,
  ariaLabel = "Actions",
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  items: ActionMenuItem[];
  ariaLabel?: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;

    const reposition = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;

      menu.style.visibility = "hidden";
      const triggerRect = trigger.getBoundingClientRect();
      const { top, left } = computeMenuPosition(
        triggerRect,
        menu.offsetWidth,
        menu.offsetHeight,
      );
      menu.style.top = `${top}px`;
      menu.style.left = `${left}px`;
      menu.style.visibility = "visible";
    };

    reposition();
    const firstItem = menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)');
    firstItem?.focus();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, triggerRef, items]);

  useLayoutEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      onClose();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onPointerDown);
    };
  }, [open, onClose, triggerRef]);

  if (!open) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="user-row-actions-menu user-row-actions-menu-portal"
      role="menu"
      aria-label={ariaLabel}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger ? "danger" : undefined}
          disabled={item.disabled}
          title={item.title}
          onClick={(event) => {
            event.stopPropagation();
            if (item.disabled) return;
            onClose();
            item.onSelect();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (item.disabled) return;
              onClose();
              item.onSelect();
            }
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
