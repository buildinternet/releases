import {
  Children,
  Fragment,
  isValidElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";
import { Item, ItemContent, ItemGroup, ItemSeparator, ItemTitle } from "@/components/ui/item";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Docs markdown tables, composed from shadcn Table + Item.
 *
 * Directory tables (2–3 columns) stay `<Table>`: identifier → meaning, with
 * wrapping description cells. Comparison tables (4+ columns) are records, not
 * a grid — they render as an `ItemGroup` of labeled items (shadcn Item), which
 * is the same job Stripe / MDN / GOV.UK solve by stacking instead of shrinking
 * columns until words fragment.
 *
 * Markdown source is unchanged, so Copy page / `.md` still get a table.
 */

type MdProps<T extends keyof HTMLElementTagNameMap> = ComponentProps<T> & { node?: unknown };

function childElements(node: ReactNode): ReactElement[] {
  return Children.toArray(node).filter(isValidElement);
}

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return textOf(props.children);
  }
  return "";
}

function cellChildren(cell: ReactElement): ReactNode {
  return (cell.props as { children?: ReactNode }).children;
}

/** First row of the first table section — GFM always emits a `<thead>`. */
export function collectHeaderTexts(children: ReactNode): string[] {
  const sections = childElements(children);
  const first = sections[0];
  if (!first) return [];
  const rows = childElements((first.props as { children?: ReactNode }).children);
  const row = rows[0];
  if (!row) return [];
  return childElements((row.props as { children?: ReactNode }).children).map((cell) =>
    textOf(cellChildren(cell)).trim(),
  );
}

function collectBodyRows(children: ReactNode): ReactNode[][] {
  const sections = childElements(children);
  const body = sections.length > 1 ? sections[1] : sections[0];
  if (!body) return [];
  const rows = childElements((body.props as { children?: ReactNode }).children);
  return rows.map((row) =>
    childElements((row.props as { children?: ReactNode }).children).map(cellChildren),
  );
}

function DocsTable({ node: _node, children, className, ...props }: MdProps<"table">) {
  const headers = collectHeaderTexts(children);
  if (headers.length >= 4) {
    return <DocsTableItems headers={headers} rows={collectBodyRows(children)} />;
  }
  return (
    <Table
      {...props}
      className={cn(headers.length === 3 && "table-fixed", className)}
      data-cols={headers.length || undefined}
    >
      {children}
    </Table>
  );
}

function DocsTableItems({ headers, rows }: { headers: string[]; rows: ReactNode[][] }) {
  return (
    <ItemGroup className="my-6 gap-0">
      {rows.map((cells, i) => (
        <Fragment key={i}>
          {i > 0 ? <ItemSeparator /> : null}
          <Item size="sm" className="items-start px-0">
            <ItemContent className="gap-3">
              <ItemTitle className="line-clamp-none">{cells[0]}</ItemTitle>
              {headers.slice(1).map((label, j) => (
                <div key={label} className="flex flex-col gap-1">
                  <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    {label}
                  </span>
                  <div>{cells[j + 1]}</div>
                </div>
              ))}
            </ItemContent>
          </Item>
        </Fragment>
      ))}
    </ItemGroup>
  );
}

function DocsThead({ node: _node, ...props }: MdProps<"thead">) {
  return <TableHeader {...props} />;
}

function DocsTbody({ node: _node, ...props }: MdProps<"tbody">) {
  return <TableBody {...props} />;
}

function DocsTr({ node: _node, ...props }: MdProps<"tr">) {
  return <TableRow {...props} />;
}

function DocsTh({ node: _node, ...props }: MdProps<"th">) {
  return <TableHead {...props} />;
}

function DocsTd({ node: _node, className, ...props }: MdProps<"td">) {
  return (
    <TableCell
      className={cn("align-top whitespace-normal [&:first-child]:font-medium", className)}
      {...props}
    />
  );
}

export const docsTableComponents = {
  table: DocsTable,
  thead: DocsThead,
  tbody: DocsTbody,
  tr: DocsTr,
  th: DocsTh,
  td: DocsTd,
};
