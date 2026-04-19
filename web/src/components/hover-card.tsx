"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

/* ================================================================
   Context
   ================================================================ */

interface HoverCardCtx {
  open: boolean;
  anchorRect: DOMRect | null;
  onEnterTrigger: (rect: DOMRect) => void;
  onLeaveTrigger: () => void;
  onEnterContent: () => void;
  onLeaveContent: () => void;
}

const Ctx = createContext<HoverCardCtx | null>(null);

function useHoverCard() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("HoverCard subcomponents must be inside HoverCard.Root");
  return ctx;
}

/* ================================================================
   Root
   ================================================================ */

const OPEN_DELAY = 120;
const CLOSE_DELAY = 150;

function Root({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(null);

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  const onEnterTrigger = useCallback(
    (rect: DOMRect) => {
      clearTimers();
      setAnchorRect(rect);
      openTimer.current = setTimeout(() => setOpen(true), OPEN_DELAY);
    },
    [clearTimers],
  );

  const onLeaveTrigger = useCallback(() => {
    clearTimers();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY);
  }, [clearTimers]);

  const onEnterContent = useCallback(() => {
    clearTimers();
  }, [clearTimers]);

  const onLeaveContent = useCallback(() => {
    clearTimers();
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY);
  }, [clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  return (
    <Ctx.Provider
      value={{ open, anchorRect, onEnterTrigger, onLeaveTrigger, onEnterContent, onLeaveContent }}
    >
      {children}
    </Ctx.Provider>
  );
}

/* ================================================================
   Trigger — wrap around the hoverable element
   ================================================================ */

function Trigger({ children, className, style, ...props }: React.ComponentPropsWithoutRef<"div">) {
  const { onEnterTrigger, onLeaveTrigger } = useHoverCard();
  const ref = useRef<HTMLDivElement>(null);

  const onPointerEnter = useCallback(() => {
    if (ref.current) {
      onEnterTrigger(ref.current.getBoundingClientRect());
    }
  }, [onEnterTrigger]);

  return (
    <div
      ref={ref}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onLeaveTrigger}
      className={className}
      style={style}
      {...props}
    >
      {children}
    </div>
  );
}

/* ================================================================
   Content — the floating card
   ================================================================ */

type Align = "center" | "start" | "end";
type Side = "top" | "bottom";

function Content({
  children,
  className,
  align = "center",
  side = "top",
  sideOffset = 6,
}: {
  children: ReactNode;
  className?: string;
  align?: Align;
  side?: Side;
  sideOffset?: number;
}) {
  const { open, anchorRect, onEnterContent, onLeaveContent } = useHoverCard();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open || !anchorRect || !ref.current) {
      setPos(null);
      return;
    }

    const card = ref.current.getBoundingClientRect();

    // anchorRect is viewport-relative (from getBoundingClientRect) and the
    // portal uses position:fixed, so no scroll offset is needed.
    let top: number;
    if (side === "top") {
      top = anchorRect.top - card.height - sideOffset;
    } else {
      top = anchorRect.bottom + sideOffset;
    }

    let left: number;
    if (align === "center") {
      left = anchorRect.left + anchorRect.width / 2 - card.width / 2;
    } else if (align === "start") {
      left = anchorRect.left;
    } else {
      left = anchorRect.right - card.width;
    }

    // Keep within viewport
    const pad = 8;
    left = Math.max(pad, Math.min(left, window.innerWidth - card.width - pad));
    if (top < pad) {
      top = anchorRect.bottom + sideOffset;
    }

    setPos({ top, left });
  }, [open, anchorRect, align, side, sideOffset]);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      ref={ref}
      role="tooltip"
      onPointerEnter={onEnterContent}
      onPointerLeave={onLeaveContent}
      className={`fixed z-50 pointer-events-auto transition-opacity duration-100 ${className ?? ""}`}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden", top: 0, left: 0 }}
    >
      {children}
    </div>,
    document.body,
  );
}

/* ================================================================
   Export
   ================================================================ */

export const HoverCard = {
  Root,
  Trigger,
  Content,
};
