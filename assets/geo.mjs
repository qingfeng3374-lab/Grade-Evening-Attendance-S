const degrees = Math.PI / 180;
const earth = 6371008.8;

export const campusNames = ["唐岛湾校区", "古镇口校区", "东营科教园区"];

function insist(ok, message) {
  if (!ok) throw new Error(message);
}

export function validateGeometry(input) {
  const g = input?.type === "Feature" ? input.geometry : input;
  insist(g && ["Polygon", "MultiPolygon"].includes(g.type), "围栏文件须包含 GeoJSON Polygon 或 MultiPolygon。");
  const polygons = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  insist(Array.isArray(polygons) && polygons.length > 0 && polygons.length <= 50, "围栏多边形数量有误。");
  let count = 0;
  for (const polygon of polygons) {
    insist(Array.isArray(polygon) && polygon.length > 0 && polygon.length <= 50, "围栏中有无效的多边形。");
    for (const ring of polygon) {
      insist(Array.isArray(ring) && ring.length >= 4, "围栏的每个环至少需要四个坐标。");
      count += ring.length;
      for (const point of ring) {
        insist(Array.isArray(point) && Number.isFinite(point[0]) && Math.abs(point[0]) <= 180
          && Number.isFinite(point[1]) && Math.abs(point[1]) <= 90, "围栏坐标须为 WGS 84 [经度, 纬度]。");
      }
      insist(ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1], "围栏的首尾坐标须相同。");
      const area = ring.slice(1).reduce((sum, [x, y], i) =>
        sum + (ring[i][0] - ring[0][0]) * (y - ring[0][1]) - (x - ring[0][0]) * (ring[i][1] - ring[0][1]), 0);
      insist(Math.abs(area) > 1e-12, "围栏中有无面积的环。");
    }
  }
  insist(count <= 10000, "围栏坐标过多，请简化后再导入。");
  return {type: g.type, coordinates: g.coordinates};
}

export function validateFence(fence) {
  insist(campusNames.includes(fence?.name), "围栏校区名称有误。");
  insist(typeof fence.version === "string" && fence.version.length > 0 && fence.version.length <= 80, "围栏缺少版本。");
  insist(Number.isFinite(fence.buffer) && fence.buffer >= 0 && fence.buffer <= 2000, "周边距离须在 0 至 2000 米之间。");
  insist(Number.isFinite(fence.maxAccuracy) && fence.maxAccuracy >= 1 && fence.maxAccuracy <= 1000,
    "最大定位误差须在 1 至 1000 米之间。");
  return {...fence, geometry: validateGeometry(fence.geometry)};
}

function ringDistance(ring, lon, lat) {
  const metersX = earth * degrees * Math.cos(lat * degrees);
  const metersY = earth * degrees;
  const project = ([x, y]) => [(x - lon) * metersX, (y - lat) * metersY];
  let minimum = Infinity;
  let inside = false;
  let [ax, ay] = project(ring[0]);
  for (const point of ring.slice(1)) {
    const [bx, by] = project(point);
    const dx = bx - ax;
    const dy = by - ay;
    const squared = dx * dx + dy * dy;
    const t = squared ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / squared)) : 0;
    minimum = Math.min(minimum, Math.hypot(ax + t * dx, ay + t * dy));
    if ((ay > 0) !== (by > 0) && ax + (bx - ax) * (-ay) / (by - ay) > 0) inside = !inside;
    [ax, ay] = [bx, by];
  }
  return {inside, minimum};
}

function signedDistance(polygon, lon, lat) {
  const [shell, ...holes] = polygon.map(ring => ringDistance(ring, lon, lat));
  const inside = shell.inside && holes.every(hole => !hole.inside);
  const minimum = Math.min(shell.minimum, ...holes.map(hole => hole.minimum));
  return inside ? minimum : -minimum;
}

export function judgePosition(fences, coords) {
  const {longitude, latitude, accuracy} = coords ?? {};
  if (!Number.isFinite(longitude) || Math.abs(longitude) > 180 || !Number.isFinite(latitude)
      || Math.abs(latitude) > 90 || !Number.isFinite(accuracy) || accuracy <= 0 || !fences.length) {
    return {status: "uncertain"};
  }
  let intersects = false;
  for (const fence of fences) {
    const geometry = fence.geometry;
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    for (const polygon of polygons) {
      const distance = signedDistance(polygon, longitude, latitude) + fence.buffer;
      if (distance >= accuracy && accuracy <= fence.maxAccuracy) return {status: "pass", campus: fence.name};
      if (distance >= -accuracy || accuracy > fence.maxAccuracy) intersects = true;
    }
  }
  return {status: intersects ? "uncertain" : "outside"};
}
