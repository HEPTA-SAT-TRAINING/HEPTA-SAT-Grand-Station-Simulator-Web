import { appFeatures } from "./features.js";

const selector = document.querySelector(".feature-selector");
const trigger = document.getElementById("feature-selector-trigger");
const menu = document.getElementById("feature-selector-menu");
const itemContainer = document.getElementById("feature-selector-items");
const currentLabel = document.getElementById("feature-selector-current");
const featureViews = new Map(
  [...document.querySelectorAll("[data-feature-view]")].map((view) => [
    view.dataset.featureView,
    view,
  ]),
);

let selectedFeatureId =
  appFeatures.find((feature) => feature.enabled)?.id ?? "";

function setMenuOpen(open) {
  menu.hidden = !open;
  trigger.setAttribute("aria-expanded", String(open));
}

function selectFeature(featureId) {
  const feature = appFeatures.find(
    (candidate) => candidate.id === featureId && candidate.enabled,
  );
  if (!feature || !featureViews.has(feature.id)) return;

  selectedFeatureId = feature.id;

  for (const [id, view] of featureViews) {
    const active = id === selectedFeatureId;
    view.hidden = !active;
    view.setAttribute("aria-hidden", String(!active));
  }

  for (const item of itemContainer.querySelectorAll("[data-feature-id]")) {
    item.dataset.selected = String(item.dataset.featureId === selectedFeatureId);
  }

  currentLabel.textContent = `Viewing: ${feature.label}`;
  setMenuOpen(false);
}

for (const feature of appFeatures) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "feature-selector__item";
  item.setAttribute("role", "menuitem");
  item.dataset.featureId = feature.id;
  item.disabled = !feature.enabled;

  const label = document.createElement("span");
  label.className = "feature-selector__item-label";
  label.textContent = feature.label;

  const description = document.createElement("span");
  description.className = "feature-selector__item-description";
  description.textContent = feature.description;

  item.append(label, description);
  item.addEventListener("click", () => selectFeature(feature.id));
  itemContainer.append(item);
}

trigger.addEventListener("click", () => {
  setMenuOpen(trigger.getAttribute("aria-expanded") !== "true");
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setMenuOpen(false);
});

document.addEventListener("pointerdown", (event) => {
  if (!selector.contains(event.target)) setMenuOpen(false);
});

selectFeature(selectedFeatureId);
