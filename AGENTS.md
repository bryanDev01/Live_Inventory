# AGENTS.md

Last updated: 2026-11-26

## 0. How to read this file

This file merges three sources. Nothing from the owner's original rules or from the original anti-AI-slop file has been dropped.

- **Part A. Working contract.** How any agent must behave in this project.
- **Part B. Project context.** What is known about the product. Only facts stated by the owner or found in sources that were actually consulted.
- **Part C. Anti-AI-slop frontend rules.** The original design rules, adapted to this project.
- **Part D. Tooling integration.** From the original file, kept as conditional.
- **Part E. Sources consulted.**

**Convention.** `[OPEN]` marks a decision the owner has not made, or a fact that has not been verified. Never resolve an `[OPEN]` item by guessing. Ask.

**Precedence when two rules collide:**

1. What the owner says explicitly in the current conversation.
2. Part A.
3. Confirmed facts in Part B.
4. Part C design rules.

Part C is a bias corrector, not a list of absolute bans. The agent tends, by default, toward the statistical median of its training: centered hero, three equal cards, indigo to purple gradient, Inter, uniform radii. That median is the "AI look". The rule is: if one of these patterns is used, it must be because the product asks for it, not because the agent chose it without thinking. Every visual choice must be justifiable with a reason tied to the product, the brand or the content.

---

# PART A. WORKING CONTRACT

1. **Do nothing on your own.** Do only what is asked, when it is asked. No extra files, features, refactors, dependencies or "improvements" unless the owner requests them.
2. **Stick exactly to the data the owner provides.** Never fill a gap with a default, an example or a plausible value.
3. **Analyze in detail everything the owner says, and assume nothing.**
4. **Ask about every doubt, however small it seems.** Group the doubts in one message, say why each one blocks the work, and wait for the answer.
5. **Never make anything up.** No invented data, endpoints, limits, prices, library behavior, sources or quotes. If you do not know, say so and look it up.
6. **Research the topic with every information tool you actually have** (web search, page fetch, official docs). Prefer official sources over third-party wrappers and blog posts. State what you consulted, what you could not open (for example sites that block automated access) and what remains unverified. Never claim access you do not have.
7. **Act as a fully qualified senior analyst and as a senior developer who notices what others ignore:** edge cases, units, time zones, rounding, encodings, locale formats, failure modes, security, accessibility, and the consequences of each change.
8. **Separate in every report:** confirmed facts, interpretations, and open items.
9. **Language.** The agent must always respond in Spanish. This applies to every message, question, report and explanation addressed to the owner, even when the files, code or sources being read are in another language. Agent-facing files (this one and `PRODUCT.md`) stay in English. This rule covers the agent's replies to the owner only. It does not decide the language of the product interface, which remains `[OPEN]`.

---

# PART B. PROJECT CONTEXT

## B.1 The product

A small, private application where the owner's business enters products manually or loads them from Excel or Word files. The app reads the exchange-rate reference published by El Toque through its API, keeps the CUP equivalents and profit percentages of the products up to date, and notifies the users on their phones and laptops when the rate moves, so that they can decide to raise or lower their selling prices.

The product is small and mainly visual. The owner will define the details gradually. Do not invent fields, screens or features beyond what is written here.

## B.2 Users and devices (confirmed by the owner)

- 2 to 3 users, all with the same role.
- Closed group for the owner's business. Not a public product and not open to the public internet.
- Devices: Android phones and Windows laptops. iPhone and macOS are not targets for now. Do not spend effort on them unless asked.
- Light mode only. Do not build a dark theme or a theme toggle unless asked.

## B.3 Confirmed product behavior

- A product has: purchase price, selling price, profit percentages, the El Toque rate, and other fields the owner will add over time.
- The purchase price is initially in USD. Each product may use a different currency, chosen by the user. Leave this to the user's choice. Which currencies are selectable is `[OPEN]`.
- The CUP equivalent of the purchase price must always be visible to the user.
- The El Toque rate is checked twice a day (the owner's proposal). The owner believes the rate changes once a day. This has not been verified.
- **The selling price is never changed automatically.** When the rate changes, the app updates the derived values (CUP equivalents and the profit percentage, that is, what is gained or lost between purchase price and selling price). The user always updates the selling price.
- The users are notified as the El Toque rate goes up or down. The USD rate is the priority.
- Products enter by manual input or by loading Excel or Word files.

## B.4 Stack and hosting

- **Database: Neon** (serverless Postgres). Chosen by the owner. Supabase is not part of the stack. Do not use Supabase Auth, Supabase client libraries, Edge Functions or any other Supabase feature.
- **Backend: a small backend of the owner's own.** Chosen by the owner. Language and framework: `[OPEN]`.
- **Frontend framework: `[OPEN]`.** Astro or Next.js. Neither has been evaluated against this stack yet. Do not pick one without the owner.
- **Hosting: `[OPEN]`.** Railway or Vercel. The choice affects the database driver and where the scheduled check runs.
- **What the own backend is responsible for: proposed, not confirmed `[OPEN]`.** Calling El Toque, running the scheduled check, talking to Neon, authenticating the users and sending notifications. Confirm with the owner before building on this.

**Verified facts about Neon** (official Neon docs unless stated otherwise):

- Neon is plain Postgres. Any standard Postgres driver or ORM works.
- Every project includes a pooled connection endpoint (PgBouncer) that accepts up to 10,000 client connections. It is used by adding `-pooler` to the host name.
- The `@neondatabase/serverless` driver talks to Postgres over HTTP or WebSockets. It exists for serverless and edge runtimes where opening a TCP connection per invocation is impractical. A long-running backend can use a standard pooled driver.
- Scale to zero is on by default: the compute suspends after 5 minutes idle. It can be disabled on paid plans.
- The first request after idle pays a cold start. A third-party source (Prisma docs) gives 500 ms to a few seconds. Treat connections as disposable: verify liveness and retry.
- Neon plan limits and prices have NOT been verified. Do not quote any.

**Verified facts about scheduling and hosting:**

- `pg_cron` on Neon runs only while the compute is active. Neon recommends it only for computes that run 24/7 or have scale to zero disabled. With two checks per day the compute would normally be asleep, so `pg_cron` is not a reliable scheduler here unless scale to zero is disabled.
- Neon has announced scheduled triggers for Neon Functions. The timer lives outside the compute, so it works with scale to zero. It is described as newly shipped. Availability, plan and pricing have NOT been verified `[OPEN]`.
- The scheduler can also live in the own backend's host.
  - Vercel Hobby allows cron jobs only once per day, with imprecise timing (up to about an hour), and restricts use to personal, non-commercial purposes. Pro allows per-minute cron.
  - Railway cron has a 5 minute minimum, evaluates schedules in UTC, does not guarantee exact timing, and the task must exit when done.
- **Where the scheduled El Toque check runs: `[OPEN]`.** It must be exactly one origin, and it must match the origin declared in the El Toque registration form (see B.5). If the own backend makes the call, its host determines that origin.

## B.5 El Toque API integration

**Access.** The API is free. The owner requests a token through El Toque's registration form. After review, El Toque sends the token by email. The form asks for: email, full name, app name, app URL, origin URL (required), app description, intended use, and the origin of the requests (web application, mobile application, server or other), plus acceptance of the terms.

**Terms and conditions (verified in El Toque pages):**

- Always credit El Toque as the source of the data.
- The values are representative and must be treated only as a reference.
- Do not modify the data the API provides. Doing so may get the key blocked.
- Do not present the data as if it were yours. This may get the user banned from the API.
- El Toque is not responsible for how third parties use the data, does not guarantee the data is error-free, and does not guarantee availability.
- El Toque can change the terms at any time without notice. The registered email may be used to communicate changes, but that is not an obligation.
- Free during the test period. The condition may change.
- If the token is used from an origin different from the one declared at registration, access may be blocked.

**Technical contract (from a third-party wrapper of the official API; the official OpenAPI document has NOT been read, so verify everything below `[OPEN]`):**

- `GET https://tasas.eltoque.com/v1/trmi` with `Authorization: Bearer <token>`.
- Query parameters `date_from` and `date_to`. Intervals of 24 hours or more are rejected.
- Currency codes listed by wrappers: ECU, TRX, USDT_TRC20, BTC, BNB, USD, MLC. Verify against the official docs.
- **Rate limits `[OPEN]`: two sources disagree.** El Toque's announcement says the limit is one request per second (it was previously two per minute and 5000 per month). A wrapper README says 60 per minute and 10 per second per key. Verify with the official OpenAPI document once the token exists.

**Rules derived from the above:**

- Only the own backend calls El Toque (see B.4). Never the browser, never the frontend directly. The token never reaches client code.
- Cache. El Toque recommends caching to avoid consuming the allocation. Store every fetched rate in the database. The UI reads from the database and never triggers an El Toque request per page view.
- Show El Toque as the source on every screen that displays a rate or a value derived from it. Label rates as reference values with the date and time of the data. Label derived values as calculated by the app.
- If El Toque fails or is slow, show the last known rate with its timestamp, keep the app usable, and do not retry in a tight loop. If a response is rate limited (429), respect the retry information it provides.

## B.6 Data and money rules

These are engineering rules for this project.

- Never use binary floating point for money or rates. Use exact decimals (for example Postgres `numeric`) with an explicit rounding policy. Rounding: owner-confirmed 2026-11-26: 2 decimals, round half up. Money is handled in `src/lib/money.ts`.
- Store El Toque values exactly as delivered, with the fetch timestamp and the period they refer to. Never overwrite history. It is needed for change detection and audit.
- Store the currency of every price. USD is a default for new products, never a constant in code.
- The conversion direction and the rate used for each calculation must be explicit in code and visible in the UI.
- Store timestamps in UTC. The business time zone is `[OPEN]`.
- Handle decimal and thousands separators explicitly in manual input and in imports. Never rely silently on locale defaults.
- **Profit percentage formula: owner-confirmed 2026-11-26.** The app shows both margin over selling price and markup over cost, and the user chooses which one to see first. Both are computed in `src/lib/money.ts`.

## B.7 Scheduling and change detection

- Two checks per day. Compare the new rate with the last stored one and notify only when it changed.
- The USD rate is the priority. Whether other currencies also trigger notifications, and whether there is a minimum change before notifying: `[OPEN]`.
- The check must be idempotent. Running it twice must not create duplicate notifications or duplicate history rows.
- Account for the scheduler's time zone and timing variation (see B.4).
- The check must tolerate a Neon cold start: retry the connection, and do not mark the run as failed on the first slow response.
- Use a unique constraint in the database, not only application logic, to prevent duplicate rate rows and duplicate notifications.

## B.8 Notifications

- Targets are Android and Windows. The delivery mechanism is assumed to be web push because the candidate frontends are web frameworks. **The owner has not confirmed this `[OPEN]`.** A native Android app would work differently.
- Web push requirements for Android and Windows browsers are **not verified yet `[OPEN]`**. Verify them in official docs before implementing.
- Verified only for Apple platforms (relevant if iPhone or macOS is ever added): web push works in Home Screen web apps from iOS 16.4 and in Safari 16 on macOS 13 or later. Permission must be requested after a direct user action. Safari does not support invisible push and revokes the permission if a received push is not shown immediately. It uses Apple's push service without needing the Apple Developer Program. Undeliverable pushes are discarded permanently.
- Rules derived from this:
  - Always show a notification when a push is received.
  - Request notification permission only after a direct user action.
  - Persist every alert in the database and show it in an in-app list. Push alone can be lost.
  - Store each device's push subscription in the database. The own backend sends the notifications (proposed in B.4, not yet confirmed).
  - A notification says what changed (currency, previous value, new value, direction). It never implies that a selling price was changed.

## B.9 Import from Excel and Word

Formats, column mapping, templates, size limits, duplicate handling and how Word content is structured are all `[OPEN]`. Ask before designing. General rules:

- Show a preview before saving anything.
- Report errors row by row. Never fail silently and never skip rows silently.
- Never overwrite existing products silently.
- Treat file content as untrusted input. Validate it. Never execute macros or formulas.
- The import must be repeatable without creating duplicates.

## B.10 Security

- The El Toque token and the Neon connection string live only in the own backend's environment variables. Never in client code, logs or the repository.
- The browser and the frontend never connect to Neon directly. Every data access goes through the own backend.
- Authentication and authorization are the own backend's responsibility, because Supabase Auth is not used. Approach: `[OPEN]`. Restrict access to the known users. How the 2 to 3 accounts are created: `[OPEN]`.
- Use a database role with only the privileges the backend needs. Verify current Neon docs on roles before implementing.

## B.11 Open decisions (do not decide by guessing)

1. Frontend framework: Astro or Next.js.
2. Backend language and framework.
3. Hosting: Railway or Vercel, and which plan.
4. Whether the own backend is the one that calls El Toque, runs the schedule and sends notifications (proposed in B.4), and the origin declared in the El Toque form.
5. Neon plan, scale-to-zero setting and database driver (the driver depends on the host).
6. How scheduling is done: the host's cron, Neon Functions scheduled triggers, or `pg_cron` with scale to zero disabled.
7. Authentication approach and how user accounts are created.
8. Profit percentage: owner-confirmed (both shown, user chooses). See B.6.
9. Currencies selectable per product: owner-confirmed USD, MLC, EUR and CUP (2026-11-27). No currency is preselected. The backend reads the allowed set from ALLOWED_CURRENCIES, never from a hardcoded list. CUP needs no conversion; other currencies need their own stored rate.
10. Whether non-USD rate changes trigger notifications, and the minimum change that triggers one.
11. Delivery mechanism (web push is assumed) and push requirements on Android and Windows.
12. Excel and Word import details (formats, columns, duplicates, limits).
13. Interface language: owner-confirmed Spanish. The owner asked for Spanish labels and every screen is written in Spanish.
14. Business time zone. (Rounding and decimals are owner-confirmed: 2 decimals, half up.)
15. Legibility standard and color-blind scope for the colors (see C.4).
16. Whether the tools in Part D exist in the owner's workflow.
17. `DESIGN.md`: not created yet (see C.1).
18. Official El Toque OpenAPI document: not read yet. Rate limits, endpoints and response format are unverified.

## B.12 Current Neon setup scope (owner-confirmed, 2026-11-26)

- The owner requested provisioning Postgres, Managed Auth, AI Gateway, Neon Functions and Realtime on the existing `production` branch. This authorizes service setup and service-level diagnostics; it does not decide the long-term hosting platform or make these services user-facing product features by itself.
- Login is now real (owner-confirmed 2026-11-27): the user types a name and password, and the backend resolves the name to an internal email through `app_user`, then obtains a Neon Auth JWT. Accounts are created only for the known closed group. No public sign-up.
- The current Neon Function is a secret-protected, read-only health probe. It must not return product data or expose any Neon secrets. Any future product API must authenticate and authorize before accessing user data.
- Owner-confirmed 2026-11-27: the product phase is authorized. The core schema (`app_user`, `exchange_rate`, `product`, `app_setting`) exists on the `production` branch, and the `api` Function serves the authenticated inventory endpoints. Every request must carry a Neon Auth JWT whose email is mapped in `app_user`; unmapped users are rejected. The `hello` Function stays a read-only, secret-protected diagnostic and never returns product data.
- Owner-confirmed 2026-11-27: while the El Toque API key is pending, the rate is entered manually and stored with `source = 'manual'`. No scraping of El Toque pages. The manual value is shown as manually entered, with its timestamp. Rate entry is restricted to the admin account; ordinary users never see the rate controls.
- Import (owner-confirmed 2026-11-27): Excel or Word table with fixed columns: nombre, precio de compra, moneda de compra, precio de venta, moneda de venta. Always preview first, report errors per row, skip rows identical to an existing product, and insert only on explicit confirmation.
- Operational note: `neon deploy` can serve a stale bundle for an existing function slug. If a code change does not appear, recreate the function or deploy it with `neon functions deploy <slug> --src <entry>`.
- Owner-confirmed 2026-11-27: any signed-in user can create, edit (including prices and currencies) and delete products at any time. Product deletion is authorized by the owner; no approval step is required.
- Owner-confirmed 2026-11-27: the product list shows a maximum of 15 products per page, with previous and next navigation.
- Server protection: JSON request bodies are capped at 16 KB, except the import endpoint, which uses twice the configured import size. These caps exist to protect the service, not as product rules.
- Import limits are configuration, not code: `IMPORT_MAX_MB`, `IMPORT_MAX_ROWS` and `IMPORT_MAX_UNCOMPRESSED_MB` (the last one guards against archives that expand far beyond their upload size). When unset or invalid, the import endpoint refuses with a configuration error.
- Alerts (owner-confirmed 2026-11-27): every change of the USD rate creates a persisted alert for the whole group. The alert states the previous and new value and asks the user to review the prices; the selling price is never changed automatically. Alerts are shown inside the app and as a browser notification while the app is open. True background push needs a published HTTPS origin and VAPID keys, so it stays pending until hosting is decided.
- Public access (owner-confirmed 2026-11-27): the inventory at `/` has no login. Anyone with the URL can read, create, edit and delete products and import files. Only the rate and the profit-mode preference require the admin session, available at `/admin`. This is an explicit owner decision: the data is private to the group and not connected to any other service.
- Product profit limit (owner-confirmed 2026-11-27): every product has its own minimum profit over cost, stored in `product.profit_limit`, default 10%. When a rate change leaves a product at or below its limit, a `product_alert` row is created with its name, percentage and limit, and a push notification names that product. The rate-change alert was replaced by this flow; nothing mentions who changed the rate.
- Web Push (implemented 2026-11-27): a service worker at `/sw.js` shows notifications while the app is closed. Subscriptions live in `push_subscription` with the device endpoint and keys. VAPID keys are Function environment variables. The trigger is the admin rate change; each rejected subscription (404 or 410) is deleted.
- The AI Gateway is used only to check its model catalog. Do not make model-inference calls or purchase credits without explicit authorization; no AI feature has been selected.
- Realtime is provisioned and checked with a read-only `SELECT 1`. No product schema or browser live query is implemented. The current remote Realtime origin setting is inherited; do not add product queries or broaden it. A production frontend origin and any allowlist change remain `[OPEN]`.

---

# PART C. ANTI-AI-SLOP FRONTEND RULES

## C.1 Guiding principle

Before writing the first line of UI, the agent must have confirmed design context: `PRODUCT.md` (audience, tone, anti-references) and `DESIGN.md` (tokens, typography, color, radii, shadows). If they do not exist, **ask before generating**. Without direction, the anti-slop filter only produces a sterile result, not one with character.

Status in this project: `PRODUCT.md` exists with a general description. `DESIGN.md` does not exist yet. Do not generate UI before the owner confirms the design direction.

The final test: if someone looked at the interface and said "an AI made this", would you believe them immediately? If the answer is yes, there is slop.

## C.2 Absolute prohibitions (always apply, except with explicit justification)

- **DO NOT** use a `linear-gradient` of indigo, violet or purple, in backgrounds or in text. It is the most recognizable marker of a generated interface.
- **DO NOT** use Inter, Roboto, Arial, Open Sans or `system-ui` as the **only** typeface, nor as the default headline typeface. They are the fonts that make design invisible.
- **DO NOT** use gradient text (`background-clip: text`) as decoration in headlines, metrics or figures. It is hard to read and it is an AI tic.
- **DO NOT** use pure `#000` or pure `#FFF`. Always tint: warm black, off-white, gray with a hue.
- **DO NOT** use gray text on a colored background. Use a darker or lighter variant of the background color itself.
- **DO NOT** invent social proof: round figures without a source, fake client logos, testimonials from people who do not exist.
- **DO NOT** use emojis in copy, code or commit messages.
- **DO NOT** use em dashes in generated copy. Replace them with a colon, a comma or a period.
- **DO NOT** deliver components with `href="#"` as dead buttons.

## C.3 Typography

- **Choose the typeface from the brand, not from reflex.** If the project has none, propose **two concrete options** with name and justification, and wait for confirmation. Inter, Geist and Space Grotesk are valid, but they must be a **decision**, not the absence of one.
- Build a **real type scale** with clear steps (display, h1, h2, h3, body, caption). Do not put the whole page in one family and one weight.
- For display headlines, set `letter-spacing` between `-0.02em` and `-0.04em`. Do not crush the tracking, and do not use a monospaced face to "look technical" unless real code is being shown.
- Do not use a huge italic serif as a hero unless the register is genuinely editorial.

Project note: no typeface has been chosen. Numbers (prices, rates, percentages) are central to this product. Whatever typeface is proposed must show digits clearly and unambiguously, and the proposal must say so.

## C.4 Color

- **One dominant color plus one or two accents with intent.** Not four muted colors with the same weight.
- The accent must come from the product or the brand, not from a downloaded mesh gradient. If there is no brand, pick **one** accent and justify it in writing.
- Do not fall into the second reflex: emerald or cream only because purple is banned. Those are the new defaults.
- Define colors as tokens in a single place (CSS variables or Tailwind `@theme`). Do not hardcode hex values in components.
- If a component library is used (shadcn/ui, etc.), **override the theme tokens**. Shipping the defaults untouched is the tell.

**Owner requirement for this project (takes precedence over any conflicting design preference):**

- The app's main colors must be colors easily seen by a normal viewer, nothing more than that. For this project, that is the written justification for the palette: visibility, not brand storytelling.
- Light mode only.
- The legibility standard (for example a specific contrast ratio) and whether color-blind users must be covered are `[OPEN]`. Do not invent a standard. Propose options and wait.
- Recommended, pending confirmation: the direction of a rate change (up or down) should be understandable without relying on color alone, for example with an arrow or a sign plus text.

## C.5 Layout and hero

- **Do not emit the default hero:** centered badge with a sparkle icon, huge centered headline, two buttons (a gradient primary "Get Started" plus a ghost secondary), a gradient orb behind. If a centered hero is made, vary it deliberately.
- **Do not resolve every features section in exactly three equal cards with an icon on top.** Let the content decide the number and the shape. A bento grid is the same reflex, so it does not count as an escape.
- **Do not follow the template waterfall** in fixed order: hero, logo wall, three cards, testimonial carousel, stats row, pricing, FAQ, final CTA. Cut or reorder according to the real story.
- **At least one asymmetric block per page:** unequal column proportions or a composition with tension. If everything is centered and equidistant, there is no hierarchy.
- Vary the spacing between sections to create rhythm. Do not apply the same vertical `padding` to everything.
- Do not use `max-w-7xl` as the only layout strategy. Prefer fluid containers or relative proportions when the content allows it.

Project adaptation: this product is a private app, not a marketing site. Hero, logo wall, testimonials and pricing apply only if the owner ever asks for a public-facing page. The same bias still applies to app screens: do not default to a row of identical KPI cards or to one identical card per product. Let the real content (product list, rates, alerts) decide the structure. The app is used on an Android phone and on a Windows laptop, so every screen must work in both viewports.

## C.6 Components and surfaces

- **Do not apply one large uniform radius** (`rounded-2xl`) to cards, inputs, buttons and images alike. Vary the radius by element type.
- Do not combine a hairline border and a wide diffuse shadow on the same card. Pick **one** border/shadow treatment.
- Do not use a decorative colored strip on the `border-left` of normal cards. That treatment belongs to semantic alerts.
- Avoid glassmorphism (`backdrop-filter`) unless there is a real layering problem to solve.
- Every interactive component must have `hover`, `focus-visible`, `disabled` states and, where applicable, `loading` and `empty`. Do not deliver components "at rest" as if they were final.
- Do not nest cards inside cards inside cards. If a card needs another card, the information probably belongs at a different level of the hierarchy.

Project note: Android phones have no hover. Meaning must never depend on hover alone, and touch targets must be comfortable to tap.

## C.7 Content and copy

- **Copy is part of the design.** A generic headline ("Transform your workflow with AI-powered insights") ruins a good UI.
- Every headline must say **what the product does, for whom, and with what result**. If it does not, rewrite it.
- Remove AI filler: `Streamline your`, `Powerful`, `Seamless`, `Leverage`, `Cutting-edge`, `State-of-the-art`, `Unlock the power of`, `Supercharge your`. The same applies to their equivalents in any other language.
- Do not put a decorative "eyebrow" label above every headline unless it adds real information.
- Do not invent statistics, logos or testimonials. If there is no real content, design an honest empty state instead of filling with fiction.

Project note: the same applies to data. Never invent rates, products or prices and present them as real. Sample data must be clearly marked as sample data.

## C.8 Motion

- Motion must **explain a change of state** (a panel entering, a loading transition, feedback to an action), not decorate.
- One orchestrated page-load animation is worth more than twenty scattered micro-interactions.
- Do not animate layout properties (`width`, `height`, `top`, `left`). Use `transform` and `opacity`.
- Do not use elastic easing or bounces unless the product's tone explicitly calls for it.

## C.9 Self-check before delivering (checklist)

Before declaring a UI task finished, the agent must answer:

- [ ] Was the typography a **decision**, or the `Inter` reflex?
- [ ] Is the accent color justified by the owner's visibility requirement, or is it the usual indigo to purple gradient?
- [ ] Is there at least one block with asymmetric composition or visual tension?
- [ ] Do the sections have different spacing rhythm, or is everything uniform?
- [ ] Do the `hover`, `focus`, `disabled`, `empty` and `loading` states exist?
- [ ] Does the copy say something specific, or could it be on a thousand sites?
- [ ] Are there invented figures, logos or testimonials?
- [ ] If someone saw the screen and was told "an AI made this", would they believe it without doubt?

Project checks:

- [ ] Was any `[OPEN]` item decided by guessing?
- [ ] Does anything change a selling price automatically? It must not.
- [ ] Is El Toque credited wherever a rate or a derived value appears, and are derived values labeled as calculated?
- [ ] Is the El Toque token absent from client code, logs and the repository?
- [ ] Is money handled with exact decimals and explicit currencies?
- [ ] Are the main colors easy to see, in light mode?
- [ ] Does it work on an Android phone viewport and on a Windows laptop viewport?
- [ ] Is every alert stored in the database and visible in the app, not only pushed?

---

# PART D. TOOLING INTEGRATION (conditional)

The original file names the tools below. The owner has not confirmed that they exist in this project's workflow (`[OPEN]`). Apply this part only if they do. Do not assume what "ODD" means. The original file does not define it.

- **With Impeccable:** this `AGENTS.md` does not replace `DESIGN.md` or `PRODUCT.md`. Impeccable provides the command vocabulary (`/impeccable shape`, `/impeccable craft`, `/impeccable critique`, `/impeccable audit`, `/impeccable polish`, `/impeccable harden`) and its deterministic detector. Use those commands **inside the tasks that ODD already planned**, not as a decorative final step.
- **With GGA:** if GGA reviews on `pre-commit`, this file is the contract it must read. The prohibitions in C.2 and the checklist in C.9 are the points GGA must watch.
- **With Engram:** design decisions (chosen palette, justified typography, confirmed anti-references) must be saved as project memory so the next session does not restart the criteria from zero.

---

# PART E. SOURCES CONSULTED

Official El Toque pages were not directly fetchable (the site blocks automated access). Their content comes from search-result excerpts. The official OpenAPI document was not read.

- El Toque, API announcement: https://eltoque.com/eltoque-abre-acceso-a-su-api-de-las-tasas-de-cambio
- El Toque, removal of restrictions: https://eltoque.com/eltoque-anuncia-la-eliminacion-de-restricciones-de-la-api-tasas
- El Toque, terms and conditions: https://eltoque.com/api-tasas-de-eltoque-terminos-y-condiciones-de-uso
- El Toque, API FAQ: https://eltoque.com/preguntas-y-respuestas-sobre-la-api-de-eltoque
- El Toque, token registration form: https://tasas-token.eltoque.com/
- Third-party wrapper (technical contract, read in full): https://github.com/pedrocastellanos/wrapper-tasas-eltoque
- Third-party Python client (currency filters): https://pypi.org/project/pytoque/
- Neon, Postgres for serverless APIs (pooling, driver, scale to zero): https://neon.com/faqs/best-postgres-setup-serverless-apis
- Neon, serverless connection pooling: https://neon.com/docs/guides/serverless-connection-pooling
- Neon, pg_cron: https://neon.com/docs/extensions/pg_cron
- Neon, scheduled Neon Functions (announcement): https://neon.com/blog/your-neon-functions-can-now-run-on-a-schedule
- Prisma, notes on Neon (source of the cold start time, third-party): https://www.prisma.io/docs/v6/orm/overview/databases/neon
- Vercel, cron usage and pricing: https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing
- Vercel, Hobby plan: https://vercel.com/docs/plans/hobby
- Railway, cron jobs: https://docs.railway.com/guides/cron-jobs
- Apple, web push: https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers
- WebKit, web push on iOS: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados
- Neon, Astro integration: https://neon.com/docs/guides/astro
- Neon, backend overview: https://neon.com/docs/get-started/backend-overview
- Neon, CLI config: https://neon.com/docs/cli/config
- Neon, CLI link: https://neon.com/docs/cli/link
- Neon, `neon.ts` reference: https://neon.com/docs/reference/neon-ts
- Neon, Functions getting started: https://neon.com/docs/compute/functions/get-started
- Neon, Realtime query guide: https://neon.com/docs/realtime/guides/queries
- Neon, Realtime subscription guide: https://neon.com/docs/realtime/guides/subscribing
