// Additive schema: legacy accounts and venues are migrated explicitly by bootstrap.
const str = (key: string, size = 160, required = true) => ({
  key,
  type: "varchar",
  size,
  required,
});
const dt = (key: string) => ({ key, type: "datetime", required: true });
export const VKR_TABLES = [
  {
    id: "organizations",
    name: "Food service organizations",
    columns: [str("name"), dt("createdAt")],
    indexes: [],
  },
  {
    id: "role_assignments",
    name: "Organization and venue permissions",
    columns: [
      str("operatorId", 36),
      str("organizationId", 36),
      str("venueId", 36, false),
      str("role", 16),
      dt("createdAt"),
    ],
    indexes: [
      { key: "grants_operator", type: "key", attributes: ["operatorId"] },
    ],
  },
  {
    id: "reviews",
    name: "Visitor feedback",
    columns: [
      str("venueId", 36),
      str("category", 24),
      str("status", 20),
      { key: "message", type: "text", required: true },
      str("assignedTo", 80, false),
      { key: "version", type: "integer", required: true, min: 1 },
      dt("createdAt"),
      dt("updatedAt"),
    ],
    indexes: [
      {
        key: "reviews_venue_time",
        type: "key",
        attributes: ["venueId", "createdAt"],
      },
    ],
  },
  {
    id: "review_actions",
    name: "Feedback history",
    columns: [
      str("reviewId", 36),
      str("venueId", 36),
      str("actor", 80),
      { key: "beforeJson", type: "text", required: true },
      { key: "afterJson", type: "text", required: true },
      { key: "comment", type: "text", required: true },
      dt("createdAt"),
    ],
    indexes: [
      {
        key: "actions_review",
        type: "key",
        attributes: ["reviewId", "createdAt"],
      },
    ],
  },
];
