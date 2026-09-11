export type Venue = {
  name: string;
  currency: "RUB";
  backgroundColor: string;
  accentColor: string;
  logoPath: string;
  pageDurationSeconds: number;
};

export type Category = { id: string; venueId: string; name: string; sortOrder: number };
export type MenuItem = {
  id: string;
  venueId: string;
  categoryId: string;
  name: string;
  priceMinor: number;
  sortOrder: number;
  isAvailable: boolean;
};

export type PageEntry =
  | { kind: "category"; categoryId: string; name: string; repeated: boolean }
  | { kind: "item"; item: MenuItem };

export type MenuPage = { columns: PageEntry[][] };

