export function CadenceGrid({
  children,
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  return (
    <div
      data-slot="cadence-grid"
      className={`grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-3 ${className ?? ""}`}
      {...props}
    >
      {children}
    </div>
  );
}
