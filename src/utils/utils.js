// Converted to CommonJS for compatibility with `require()` in `src/main.js`
const { fetchNeighbourhoodMeta, fetchNeighbourhoodStats } = require('./api');

const convertResidentsToPercentage = (residentsCount, categoryCount) => {
    const shareOfResidents = categoryCount / residentsCount;
    const integerPercentage = Math.round(shareOfResidents * 100);
    return `${categoryCount} (${integerPercentage}%)`;
}

const getZipCode = (elementText) => {
    const zipCodeRe = /\d\d\d\d\s*[A-Z][A-Z]/;
    const match = elementText.match(zipCodeRe);

    if (match && match[0]) {
        return match[0].replaceAll(' ', '');
    }

    return null;
}

const getNeighbourhoodData = async (zipCode) => {
    const neighbourhoodMeta = await fetchNeighbourhoodMeta(zipCode);
    if (!neighbourhoodMeta) {
        return null;
    }

    const { neighbourhoodCode, neighbourhoodName, municipalityName } = neighbourhoodMeta;
    const neighbourhood = await fetchNeighbourhoodStats(neighbourhoodCode);
    if (!neighbourhood) {
        return null;
    }

    return {
        neighbourhoodName: { value: neighbourhoodName },
        municipalityName: { value: municipalityName },
        ...neighbourhood,
    };
}

module.exports = {
    convertResidentsToPercentage,
    getZipCode,
    getNeighbourhoodData,
};
