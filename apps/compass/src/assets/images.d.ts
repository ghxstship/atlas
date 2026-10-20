/** Image files Metro bundles: importing one gives the asset id React Native's Image takes. */
declare module "*.png" {
  const asset: number;
  export default asset;
}
