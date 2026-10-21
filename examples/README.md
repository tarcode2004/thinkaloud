# Examples

## Fern & Co demo shop (`demo-shop/`, `demo-shop.zip`)

A small Vite, React and react-router plant shop you can use to try ThinkAloud end to end.

- **Routes:**
  - `/`: home
  - `/c/:slug`: categories (indoor, succulents, pet-friendly, accessories)
  - `/p/:id`: product detail
  - `/cart`: basket
  - `/checkout`: checkout form with three shipping options
  - `/order/complete`: order confirmation
  - `/help`: help page
  - `/help/returns`: returns policy
- **Deliberate usability problems** for the study to find:
  1. **Promo code.**
     - The field is labelled *"Reference code (optional)"* and sits in the delivery-address
       section.
     - It is applied with a grey, icon-only "↻" button.
     - Codes are case-sensitive (`FERN10` gives 10% off, `GREENTHUMB` gives 15%; `fern10` fails
       with "Reference not recognised").
     - A successful code shows only as an *"Adjustment"* line in the order summary.
  2. **Returns policy.** It is linked only from the tiny, low-contrast legal line in the footer.
     The *Help* page in the header does not mention returns.
- **Custom events** (`window.ThinkAloud.track`): `add_to_cart`, `promo_applied {ok}`,
  `checkout_validation_error {fields}`, `order_complete {total, shipping, discount}`.
- **Test ids** for success rules: `[data-testid=add-to-cart]`, `[data-testid=place-order]`,
  `#order-complete`, `[data-testid=order-number]`.

To try it: create a study, open *App builds*, and upload `examples/demo-shop.zip`. It builds in
Docker in a few seconds and is served at `http://app-<id>.localhost:4001/`. To run it locally
instead: `cd examples/demo-shop && npm install && npm run dev`.

To rebuild the zip after editing (from `examples/`):
`zip -qr demo-shop.zip demo-shop -x 'demo-shop/node_modules/*' 'demo-shop/dist/*'`

### Sample protocol idea

**Goal:** find out whether first-time visitors can buy a specific plant with a discount and find
the returns rules, and what slows them down.

| # | Step | Content |
|---|---|---|
| 1 | Instruction | Intro, AI disclosure, and the think-aloud ask. Practice: "Take a minute to look around the home page and tell me what you think this site sells." (`showApp`, `exploreSeconds: 45`) |
| 2 | Task: *Find a pet-safe plant* | "You have a cat and want a leafy plant for your living room that's safe for her. Find one you'd consider buying." Success: `url_matches ^/p/(calathea\|spider\|parlor)`. `askSEQ`. |
| 3 | Task: *Buy with a discount* | "A friend gave you the discount code FERN10. Buy a Monstera with the fastest delivery option, and use the code." Success: `custom_event order_complete`, or `url_matches ^/order/complete`. Probes after the task: "How did applying the code go for you?" `askSEQ`, `timeLimitSec: 300`. |
| 4 | Task: *Returns* | "Your plant arrived with broken leaves. Find out what you can do about it." Success: `url_matches ^/help/returns`, or `text_visible "30 days"`. `askSEQ`. |
| 5 | Interview | Goal: trust and clarity. Questions: "What, if anything, was confusing at checkout?" and "How confident are you that your discount was applied? What made you feel that way?" |
| 6 | Questionnaire | SUS (`productName: "Fern & Co"`), then NPS. |

What you should see in the results:
- **Task 3:** misclicks on the label or the "↻" button, retries with a lowercase code, long time
  on task, and `promo_applied {ok:false}` events. Many participants will not notice the
  "Adjustment" line.
- **Task 4:** backtracking through *Help* and scrolling to the footer, so lostness will be high.

For an A/B study, make a variant B of the shop with the field labelled "Promo code", a visible
"Apply" button and a confirmation message. Upload it as a second app and assign it to variant B.
