# Operator inbox design system

The UI follows the approved Automated & CO WhatsApp inbox concept: a quiet off-white workspace, deep forest-green identity, teal actions, restrained mint conversation states, and compact message typography.

- Layout: 370 px conversation rail plus flexible chat canvas on desktop; list-to-chat navigation below 800 px.
- Typography: local system sans-serif stack for offline reliability, with 10–15 px operator-density text and 22 px empty-state heading.
- Color tokens: ink `#173532`, deep green `#113c38`, teal `#0e766c`, mint `#dff2e9`, border `#dce5e1`, paper `#fbfcfb`.
- Shape: 20 px application shell, 10–13 px controls, circular contact initials, asymmetric message-bubble corners.
- States: amber human badges, mint bot badges, teal unread counters, explicit human/bot banner, blue read receipts, and red failed-send text.
- Privacy: masked phone numbers and a persistent local-only footer. Public names remain visible under local aliases.
- Scope correction: inactive conversations are never hidden. There are no new-chat, campaign, template, CRM, order, or outbound-attachment controls.
