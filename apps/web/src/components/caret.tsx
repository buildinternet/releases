/** Small disclosure caret — points right when closed, rotates 90° down when
 *  open. Shared by the collection and org release feeds' rollup headers. */
export function Caret({ open }: { open: boolean }) {
  return (
    <svg
      width="9"
      height="9"
      viewBox="0 0 9 9"
      fill="none"
      aria-hidden="true"
      className="flex-none transition-transform"
      style={{ transform: open ? "rotate(90deg)" : "none" }}
    >
      <path
        d="M2.5 1.5 L6 4.5 L2.5 7.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
