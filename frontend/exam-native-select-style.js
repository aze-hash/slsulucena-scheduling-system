
(function () {
    "use strict";

    function upgradeSelect(select) {
        if (!select || select.dataset.msdStyled === "true") return;
        select.dataset.msdStyled = "true";

        const isPlaceholder = (opt) => !opt || opt.value === "";

        // Wrapper uses the same .msd classes as the custom dropdowns
        const wrap = document.createElement("div");
        wrap.className = "msd exam-native-select";

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "msd-toggle";

        const label = document.createElement("span");
        label.className = "msd-label";

        const arrow = document.createElement("span");
        arrow.className = "msd-arrow";
        arrow.textContent = "▾";

        toggle.appendChild(label);
        toggle.appendChild(arrow);

        const menu = document.createElement("div");
        menu.className = "msd-menu";
        menu.style.display = "none";

        const list = document.createElement("div");
        list.className = "msd-options-list";

        function updateLabel() {
            const opt = select.options[select.selectedIndex];
            if (isPlaceholder(opt)) {
                label.textContent = opt ? opt.textContent : "Select";
                label.classList.add("is-placeholder");
            } else {
                label.textContent = opt.textContent;
                label.classList.remove("is-placeholder");
            }
        }

        function buildMenu() {
            list.innerHTML = "";
            Array.from(select.options).forEach((opt) => {
                const item = document.createElement("div");
                item.className = "msd-option";
                item.setAttribute("data-value", opt.value);
                const text = document.createElement("span");
                text.className = "msd-option-text";
                text.textContent = opt.textContent;
                if (isPlaceholder(opt)) {
                    text.style.color = "#555";
                    text.style.fontStyle = "italic";
                }
                item.appendChild(text);
                item.addEventListener("click", () => {
                    select.value = opt.value;
                    // Fire the same event the native select would fire,
                    // so all existing listeners keep working unchanged.
                    select.dispatchEvent(new Event("change", { bubbles: true }));
                    updateLabel();
                    refreshSelection();
                    close();
                });
                list.appendChild(item);
            });
        }

        function refreshSelection() {
            Array.from(list.children).forEach((item) => {
                const selected = item.getAttribute("data-value") === select.value;
                item.style.background = selected ? "rgba(46,125,50,.12)" : "";
                item.style.fontWeight = selected ? "600" : "";
            });
        }

        function open() {
            buildMenu();
            refreshSelection();
            menu.style.display = "block";
            wrap.classList.add("open");
            const card = wrap.closest(".card");
            if (card) card.classList.add("msd-elevated");
        }

        function close() {
            menu.style.display = "none";
            wrap.classList.remove("open");
            const card = wrap.closest(".card");
            if (card) card.classList.remove("msd-elevated");
        }

        toggle.addEventListener("click", (e) => {
            e.stopPropagation();
            const isOpen = menu.style.display === "block";
            // close any other open .msd menus
            document.querySelectorAll(".msd.open").forEach((m) => {
                if (m !== wrap) {
                    m.classList.remove("open");
                    const mm = m.querySelector(".msd-menu");
                    if (mm) mm.style.display = "none";
                }
            });
            if (isOpen) { close(); } else { open(); }
        });

        document.addEventListener("click", (e) => {
            if (!wrap.contains(e.target)) close();
        });

        // Keep the visual label in sync if anything else changes the select
        select.addEventListener("change", updateLabel);

        // Hide the native select visually (keep it functional & accessible)
        select.style.display = "none";
        select.setAttribute("aria-hidden", "true");

        wrap.appendChild(toggle);
        wrap.appendChild(menu);
        menu.appendChild(list);
        select.parentNode.insertBefore(wrap, select);
        // keep the hidden select inside the wrapper (harmless, keeps DOM tidy)
        wrap.appendChild(select);

        updateLabel();
    }

    function upgradeAll() {
        document.querySelectorAll("select.exam-native-select").forEach(upgradeSelect);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", upgradeAll);
    } else {
        upgradeAll();
    }
})();