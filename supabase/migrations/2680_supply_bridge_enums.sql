-- 2680_supply_bridge_enums.sql
-- R7a Supply bridge (RRR-183, ADR 0104 section 4). Enum additions only: Postgres cannot use an enum value in the
-- transaction that adds it, so 2681 to 2683 use these values in their own files.
--
--   * app.asset_state gains Returned, the tenth asset state: the unit went back to its vendor, at a rental's off-hire
--     or as a purchase return. It is terminal and is never Retired (retiring is a write-off, which needs
--     assets.write_off.approve, 0352).
--   * app.asset_lot_movement_kind gains Receipt (stock in from a goods receipt) and Vendor Return (stock out to the
--     vendor through a goods return).
--   * app.acquisition_kind says whether an order line buys or hires its item.
--   * app.goods_return_reason says why goods went back to the vendor.

alter type app.asset_state add value 'Returned' after 'Retired';
comment on type app.asset_state is 'The ten-value asset lifecycle (Section 7.4, Section 3.12 lifecycle 3, ADR 0104). Retired and Returned are terminal; retiring needs assets.write_off.approve, and a unit becomes Returned only through a goods return (app.return_goods, 2681).';

alter type app.asset_lot_movement_kind add value 'Receipt';
alter type app.asset_lot_movement_kind add value 'Vendor Return';
comment on type app.asset_lot_movement_kind is 'Why a lot quantity moved: a recount, a check-out to a member or engagement, a check-in, a receipt against a purchase order line, or a return to the vendor.';

create type app.acquisition_kind as enum ('Purchase', 'Rental');
comment on type app.acquisition_kind is 'How an order line acquires its item: bought outright, or hired for a period and returned to the vendor at off-hire (ADR 0104).';

create type app.goods_return_reason as enum ('Off Hire', 'Defective', 'Wrong Item', 'Over Delivery');
comment on type app.goods_return_reason is 'Why goods went back to the vendor: a rental reached its off-hire, or the goods were defective, the wrong item or more than ordered.';
