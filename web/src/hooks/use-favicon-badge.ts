"use client";

import { useEffect, useRef } from "react";

type BadgeState = { connected: boolean; hasUnseen: boolean };

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function renderFavicon({ connected, hasUnseen }: BadgeState): string | null {
  if (typeof document === "undefined") return null;
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // Base icon — mirrors web/src/app/icon.svg.
  ctx.fillStyle = "#1c1917";
  roundRect(ctx, 0, 0, size, size, 14);
  ctx.fill();

  ctx.fillStyle = "#f5f5f4";
  roundRect(ctx, 14, 18, 28, 6, 1.5);
  ctx.fill();

  ctx.globalAlpha = 0.7;
  roundRect(ctx, 14, 29, 22, 6, 1.5);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.fillStyle = "#3b82f6";
  roundRect(ctx, 14, 40, 36, 6, 1.5);
  ctx.fill();

  const dotRadius = 11;
  const inset = 11;

  // Connected indicator — green, bottom-right.
  if (connected) {
    ctx.fillStyle = "#10b981";
    ctx.strokeStyle = "#1c1917";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(size - inset, size - inset, dotRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  // Unseen indicator — red, top-right.
  if (hasUnseen) {
    ctx.fillStyle = "#ef4444";
    ctx.strokeStyle = "#1c1917";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(size - inset, inset, dotRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  return canvas.toDataURL("image/png");
}

/**
 * Swaps the document favicon with a PNG data URL that overlays live-status
 * dots on top of the base icon. Restores the originals on unmount.
 *
 * Intended for pages where favicon state is meaningful (e.g. /live).
 */
export function useFaviconBadge({ connected, hasUnseen }: BadgeState) {
  const originalsRef = useRef<{ link: HTMLLinkElement; href: string; type: string | null }[]>([]);
  const injectedRef = useRef<HTMLLinkElement | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
    originalsRef.current = links.map((link) => ({
      link,
      href: link.href,
      type: link.getAttribute("type"),
    }));
    return () => {
      originalsRef.current.forEach(({ link, href, type }) => {
        link.href = href;
        if (type) link.setAttribute("type", type);
        else link.removeAttribute("type");
      });
      originalsRef.current = [];
      injectedRef.current?.remove();
      injectedRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const href = renderFavicon({ connected, hasUnseen });
    if (!href) return;
    const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
    if (links.length === 0) {
      if (!injectedRef.current) {
        const link = document.createElement("link");
        link.rel = "icon";
        document.head.appendChild(link);
        injectedRef.current = link;
      }
      injectedRef.current.type = "image/png";
      injectedRef.current.href = href;
    } else {
      links.forEach((link) => {
        link.type = "image/png";
        link.href = href;
      });
    }
  }, [connected, hasUnseen]);
}
