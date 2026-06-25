import { ListCard, ListRow } from "@releases/design-system";

export function ConnectedSources() {
  return (
    <div style={{ width: 420 }}>
      <ListCard>
        <ListRow>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "#1c1917" }}>
              github.com/vercel/next.js
            </div>
            <div style={{ fontSize: 12, color: "#78716c", marginTop: 2 }}>
              GitHub releases · fetched 2 min ago
            </div>
          </div>
          <div style={{ fontSize: 12, color: "#78716c", flexShrink: 0 }}>Remove</div>
        </ListRow>
        <ListRow>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "#1c1917" }}>
              stripe.com/changelog
            </div>
            <div style={{ fontSize: 12, color: "#78716c", marginTop: 2 }}>
              Scrape · fetched 18 min ago
            </div>
          </div>
          <div style={{ fontSize: 12, color: "#78716c", flexShrink: 0 }}>Remove</div>
        </ListRow>
        <ListRow>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "#1c1917" }}>
              blog.cloudflare.com/rss
            </div>
            <div style={{ fontSize: 12, color: "#78716c", marginTop: 2 }}>
              Feed · fetched 1 hr ago
            </div>
          </div>
          <div style={{ fontSize: 12, color: "#78716c", flexShrink: 0 }}>Remove</div>
        </ListRow>
      </ListCard>
    </div>
  );
}

export function FollowedProducts() {
  return (
    <div style={{ width: 420 }}>
      <ListCard>
        <ListRow>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "#1c1917" }}>Next.js</div>
            <div style={{ fontSize: 12, color: "#78716c", marginTop: 2 }}>
              Vercel · 214 releases
            </div>
          </div>
          <div style={{ fontSize: 12, color: "#78716c", flexShrink: 0 }}>Unfollow</div>
        </ListRow>
        <ListRow>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "#1c1917" }}>Stripe API</div>
            <div style={{ fontSize: 12, color: "#78716c", marginTop: 2 }}>Stripe · 48 releases</div>
          </div>
          <div style={{ fontSize: 12, color: "#78716c", flexShrink: 0 }}>Unfollow</div>
        </ListRow>
        <ListRow>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "#1c1917" }}>Workers</div>
            <div style={{ fontSize: 12, color: "#78716c", marginTop: 2 }}>
              Cloudflare · 92 releases
            </div>
          </div>
          <div style={{ fontSize: 12, color: "#78716c", flexShrink: 0 }}>Unfollow</div>
        </ListRow>
        <ListRow>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500, color: "#1c1917" }}>Linear</div>
            <div style={{ fontSize: 12, color: "#78716c", marginTop: 2 }}>Linear · 31 releases</div>
          </div>
          <div style={{ fontSize: 12, color: "#78716c", flexShrink: 0 }}>Unfollow</div>
        </ListRow>
      </ListCard>
    </div>
  );
}
