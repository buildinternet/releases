"use client";

/**
 * ConveyorBackground — a kinda-3D "advancing blocks" backdrop for releases.sh.
 *
 * Drop it in once, near the top of your layout/page, behind your content:
 *
 *   <ConveyorBackground />          // sensible defaults (white blocks, emerald ship-flash)
 *   <main className="relative z-10"> ... </main>
 *
 * The two knobs you'll reach for most:
 *
 *   <ConveyorBackground baseColor="255,255,255" density={1.4} />
 *
 * Color is fully configurable — pass rgb triplets ("r,g,b"):
 *   baseColor   the blocks themselves (default white)
 *   accentColor the brief "shipped" flash (default emerald)
 *   → set accentColor === baseColor for a pure-grayscale look (no green at all),
 *     or set shipFrequency={0} to disable flashes entirely.
 *
 * Density is a single multiplier: higher = more lanes and tighter packing.
 *   density={0.7}  sparse / calm        density={1} default        density={1.8} busy
 *
 * Honors prefers-reduced-motion (renders a static frame), pauses when the tab
 * is hidden or the canvas scrolls out of view, and is devicePixelRatio-aware.
 */

import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";

export interface ConveyorBackgroundProps {
  /** rgb triplet for the blocks, e.g. "255,255,255". Default white. */
  baseColor?: string;
  /** rgb triplet for the brief ship flash, e.g. "74,222,128". Set === baseColor for mono. */
  accentColor?: string;
  /** Opacity multiplier. ~0.5 = very subtle, 1 = default, >1 = bolder. */
  intensity?: number;
  /** Motion multiplier. 1 = default. */
  speed?: number;
  /** Lane count + packing multiplier. 0.7 sparse, 1 default, 1.8 busy. */
  density?: number;
  /** Relative rate of green "shipped" flashes. 0 disables them, 1 default. */
  shipFrequency?: number;
  /** "fill" = solid extruded blocks (default), "outline" = wireframe boxes. */
  variant?: "fill" | "outline";
  className?: string;
  style?: CSSProperties;
}

export default function ConveyorBackground({
  baseColor = "255,255,255",
  accentColor = "74,222,128",
  intensity = 1,
  speed = 1,
  density = 1,
  shipFrequency = 1,
  variant = "fill",
  className,
  style,
}: ConveyorBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const ink3 = baseColor.split(",").map(Number);
    const acc3 = accentColor.split(",").map(Number);
    const ink = (a: number) => `rgba(${baseColor}, ${a})`;
    // blend base → accent by `flash` (0..1), nudging alpha up a touch on flash
    const mix = (a: number, flash: number) => {
      const r = ink3.map((c, i) => Math.round(c + (acc3[i] - c) * flash));
      return `rgba(${r[0]}, ${r[1]}, ${r[2]}, ${Math.min(1, a + flash * 0.18)})`;
    };

    const BASE_LANE_SPACING = 120; // px between lanes at density=1

    let W = 0,
      H = 0,
      DPR = 1;
    let lanes: Lane[] = [];
    let running = true;
    let raf = 0;
    let last = performance.now();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    interface Block {
      x: number;
      w: number;
      flash: number;
      shipping: boolean;
    }
    interface Lane {
      y: number;
      depth: number;
      h: number;
      speed: number;
      blocks: Block[];
    }

    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    const pick = <T,>(arr: T[]) => arr[(Math.random() * arr.length) | 0];

    function build() {
      const spacing = BASE_LANE_SPACING / Math.max(0.2, density);
      const n = Math.max(4, Math.round(H / spacing));
      const gapMin = 46 / Math.max(0.2, density);
      const gapMax = 150 / Math.max(0.2, density);
      lanes = [];
      for (let i = 0; i < n; i++) {
        const depth = (i + 0.5) / n; // 0 = back (small/dim), 1 = front
        const lane: Lane = {
          y: (i + 0.5) * (H / n),
          depth,
          h: 7 + depth * 17,
          speed: 10 + depth * 26,
          blocks: [],
        };
        let x = rand(-W, 0);
        while (x < W * 1.5) {
          const w = rand(30, 92) * (0.6 + depth);
          lane.blocks.push({ x, w, flash: 0, shipping: false });
          x += w + rand(gapMin, gapMax);
        }
        lanes.push(lane);
      }
    }

    function drawExtruded(
      x: number,
      y: number,
      w: number,
      h: number,
      depth: number,
      a: number,
      flash: number,
    ) {
      const d = 3 + depth * 5; // extrude distance (light from upper-right)

      if (variant === "outline") {
        // Wireframe extruded box: front rectangle + the visible depth edges
        // (top + right faces). Normally stroke-only; a "shipped" box fills solid
        // with the accent (green) and fades back to a bare outline as the flash
        // decays. The fill alpha is driven by `flash` rather than the base
        // intensity, so the green highlight pops even when the outlines are faint.
        const shipping = flash > 0.01;
        if (shipping) {
          const fa = flash * 0.85;
          // right side face
          ctx!.fillStyle = `rgba(${accentColor}, ${fa * 0.6})`;
          ctx!.beginPath();
          ctx!.moveTo(x + w, y);
          ctx!.lineTo(x + w + d, y - d);
          ctx!.lineTo(x + w + d, y - d + h);
          ctx!.lineTo(x + w, y + h);
          ctx!.closePath();
          ctx!.fill();
          // top face
          ctx!.fillStyle = `rgba(${accentColor}, ${Math.min(1, fa * 1.1)})`;
          ctx!.beginPath();
          ctx!.moveTo(x, y);
          ctx!.lineTo(x + d, y - d);
          ctx!.lineTo(x + w + d, y - d);
          ctx!.lineTo(x + w, y);
          ctx!.closePath();
          ctx!.fill();
          // front face
          ctx!.fillStyle = `rgba(${accentColor}, ${fa})`;
          ctx!.fillRect(x, y, w, h);
        }
        // Strokes ride brighter than the fill alpha so thin 1px lines still read;
        // accent-colored while shipping so the crate's edges stay crisp.
        const strokeA = shipping ? Math.min(0.95, flash) : Math.min(0.85, a * 2.4);
        ctx!.lineWidth = 1;
        ctx!.lineJoin = "round";
        ctx!.strokeStyle = shipping ? `rgba(${accentColor}, ${strokeA})` : ink(strokeA);
        ctx!.beginPath();
        // front face
        ctx!.rect(x, y, w, h);
        // depth edges from the front corners back to the top face
        ctx!.moveTo(x, y);
        ctx!.lineTo(x + d, y - d);
        ctx!.moveTo(x + w, y);
        ctx!.lineTo(x + w + d, y - d);
        ctx!.moveTo(x + w, y + h);
        ctx!.lineTo(x + w + d, y - d + h);
        // back top edge + back right vertical
        ctx!.moveTo(x + d, y - d);
        ctx!.lineTo(x + w + d, y - d);
        ctx!.lineTo(x + w + d, y - d + h);
        ctx!.stroke();
        return;
      }

      const side = a * 0.55;
      const top = Math.min(1, a * 1.9 + 0.02);
      // right side face
      ctx!.fillStyle = ink(side);
      ctx!.beginPath();
      ctx!.moveTo(x + w, y);
      ctx!.lineTo(x + w + d, y - d);
      ctx!.lineTo(x + w + d, y - d + h);
      ctx!.lineTo(x + w, y + h);
      ctx!.closePath();
      ctx!.fill();
      // top face
      ctx!.fillStyle = ink(top);
      ctx!.beginPath();
      ctx!.moveTo(x, y);
      ctx!.lineTo(x + d, y - d);
      ctx!.lineTo(x + w + d, y - d);
      ctx!.lineTo(x + w, y);
      ctx!.closePath();
      ctx!.fill();
      // front face (the only face that takes the ship flash)
      ctx!.fillStyle = flash > 0.01 ? mix(a, flash) : ink(a);
      ctx!.fillRect(x, y, w, h);
    }

    function frame(now: number) {
      if (!running) return;
      let dt = (now - last) / 1000;
      last = now;
      dt = Math.min(dt, 0.05); // clamp big gaps (tab refocus)
      if (reduced) dt = 0;

      ctx!.clearRect(0, 0, W, H);

      const perLaneShip = (0.008 * shipFrequency) / Math.max(1, lanes.length);

      for (const lane of lanes) {
        const baseA = (0.035 + lane.depth * 0.075) * intensity;
        let rightmost = -Infinity;
        for (const b of lane.blocks) {
          const v = lane.speed * (b.shipping ? 1.8 : 1) * speed;
          b.x += v * dt;
          if (b.flash > 0) b.flash = Math.max(0, b.flash - dt / 0.7);
          if (b.flash === 0) b.shipping = false;
          rightmost = Math.max(rightmost, b.x + b.w);
        }
        for (const b of lane.blocks) {
          if (b.x > W + 24) {
            b.w = rand(30, 92) * (0.6 + lane.depth);
            const gapMax = 150 / Math.max(0.2, density);
            const gapMin = 46 / Math.max(0.2, density);
            b.x = Math.min(-b.w - 24, rightmost - W - rand(gapMin, gapMax));
            rightmost = b.x + b.w;
            b.flash = 0;
            b.shipping = false;
          }
        }
        if (shipFrequency > 0 && Math.random() < perLaneShip) {
          const cand = lane.blocks.filter((b) => !b.shipping && b.x > 0 && b.x < W * 0.7);
          if (cand.length) {
            const b = pick(cand);
            b.flash = 1;
            b.shipping = true;
          }
        }
        for (const b of lane.blocks) {
          drawExtruded(b.x, lane.y - lane.h / 2, b.w, lane.h, lane.depth, baseA, b.flash);
        }
      }
      raf = requestAnimationFrame(frame);
    }

    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas!.clientWidth;
      H = canvas!.clientHeight;
      canvas!.width = Math.floor(W * DPR);
      canvas!.height = Math.floor(H * DPR);
      ctx!.setTransform(DPR, 0, 0, DPR, 0, 0);
      build();
      if (reduced) {
        // paint a single static frame, no animation loop
        const wasRunning = running;
        running = true;
        frame(performance.now());
        running = wasRunning;
        cancelAnimationFrame(raf);
      }
    }

    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    // The pause contract requires BOTH conditions: resume only when the masthead
    // is in view AND the tab is visible (and motion isn't reduced). Gating on a
    // single signal lets one observer restart the loop while the other still says
    // "paused" — e.g. refocusing the tab while scrolled past the band.
    let isInView = true;
    let isPageVisible = !document.hidden;
    const syncRunState = () => {
      const shouldRun = !reduced && isInView && isPageVisible;
      if (shouldRun && !running) {
        running = true;
        last = performance.now();
        raf = requestAnimationFrame(frame);
      } else if (!shouldRun && running) {
        stop();
      }
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    // pause when scrolled out of view
    const io = new IntersectionObserver(
      ([entry]) => {
        isInView = entry.isIntersecting;
        syncRunState();
      },
      { threshold: 0 },
    );
    io.observe(canvas);

    // pause when tab hidden
    const onVis = () => {
      isPageVisible = !document.hidden;
      syncRunState();
    };
    document.addEventListener("visibilitychange", onVis);

    resize();
    running = false;
    syncRunState();

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [baseColor, accentColor, intensity, speed, density, shipFrequency, variant]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={className}
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100%",
        zIndex: 0,
        pointerEvents: "none",
        ...style,
      }}
    />
  );
}
