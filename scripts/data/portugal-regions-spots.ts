export type PortugalSpotSeed = {
  name: string;
  level: string;
  breakType: string;
  consistency: string;
};

export type PortugalRegionSeed = {
  name: string;
  spots: PortugalSpotSeed[];
};

/** Portugal surf regions and spots (country code PT). */
export const PORTUGAL_REGIONS: PortugalRegionSeed[] = [
  {
    name: 'North Portugal',
    spots: [
      {
        name: 'Cabedelo (Viana)',
        level: 'Beginner–Advanced',
        breakType: 'Rivermouth / Beach break',
        consistency: 'High',
      },
      {
        name: 'Afife',
        level: 'Intermediate',
        breakType: 'Beach break',
        consistency: 'Medium',
      },
      {
        name: 'Amorosa',
        level: 'Intermediate',
        breakType: 'Beach break',
        consistency: 'Medium',
      },
      {
        name: 'Ofir',
        level: 'Intermediate–Advanced',
        breakType: 'Sandbar / Rivermouth',
        consistency: 'Medium',
      },
      {
        name: 'Matosinhos',
        level: 'Beginner',
        breakType: 'Beach break',
        consistency: 'High',
      },
      {
        name: 'Leça da Palmeira',
        level: 'Intermediate',
        breakType: 'Reef / Beach',
        consistency: 'Medium',
      },
    ],
  },
  {
    name: 'Aveiro',
    spots: [
      {
        name: 'Barra',
        level: 'Intermediate',
        breakType: 'Beach break',
        consistency: 'High',
      },
      {
        name: 'Costa Nova',
        level: 'Beginner–Intermediate',
        breakType: 'Beach break',
        consistency: 'Medium',
      },
    ],
  },
  {
    name: 'Figueira da Foz',
    spots: [
      {
        name: 'Cabedelo',
        level: 'Intermediate–Advanced',
        breakType: 'Point / Rivermouth',
        consistency: 'Very High',
      },
      {
        name: 'Buarcos',
        level: 'Advanced',
        breakType: 'Reef / Point',
        consistency: 'Medium',
      },
    ],
  },
  {
    name: 'Nazaré',
    spots: [
      {
        name: 'Praia do Norte',
        level: 'Expert Only',
        breakType: 'Canyon Big Wave',
        consistency: 'Medium',
      },
      {
        name: 'Praia da Nazaré',
        level: 'Beginner',
        breakType: 'Beach break',
        consistency: 'Medium',
      },
    ],
  },
  {
    name: 'Peniche',
    spots: [
      {
        name: 'Supertubos',
        level: 'Advanced–Expert',
        breakType: 'Hollow Beach break',
        consistency: 'Very High',
      },
      {
        name: 'Molhe Leste',
        level: 'Beginner–Intermediate',
        breakType: 'Protected Beach break',
        consistency: 'High',
      },
      {
        name: 'Lagide',
        level: 'Intermediate–Advanced',
        breakType: 'Reef break',
        consistency: 'High',
      },
      {
        name: 'Cantinho da Baía',
        level: 'Beginner',
        breakType: 'Beach break',
        consistency: 'Very High',
      },
      {
        name: 'Almagreira',
        level: 'Intermediate',
        breakType: 'Beach break',
        consistency: 'High',
      },
      {
        name: 'Consolação',
        level: 'Intermediate–Advanced',
        breakType: 'Reef / Point',
        consistency: 'High',
      },
    ],
  },
  {
    name: 'Ericeira',
    spots: [
      {
        name: "Ribeira d'Ilhas",
        level: 'Intermediate–Advanced',
        breakType: 'Point break',
        consistency: 'Very High',
      },
      {
        name: 'Coxos',
        level: 'Advanced–Expert',
        breakType: 'Heavy Reef',
        consistency: 'High',
      },
      {
        name: 'Pedra Branca',
        level: 'Advanced',
        breakType: 'Reef break',
        consistency: 'Medium',
      },
      {
        name: 'Cave',
        level: 'Expert Only',
        breakType: 'Slab / Reef',
        consistency: 'Low–Medium',
      },
      {
        name: 'Foz do Lizandro',
        level: 'Beginner–Intermediate',
        breakType: 'Beach break',
        consistency: 'High',
      },
      {
        name: 'São Julião',
        level: 'Beginner–Intermediate',
        breakType: 'Beach break',
        consistency: 'High',
      },
      {
        name: 'Matadouro',
        level: 'Intermediate',
        breakType: 'Reef / Point',
        consistency: 'Medium',
      },
    ],
  },
  {
    name: 'Santa Cruz',
    spots: [
      {
        name: 'Praia Azul',
        level: 'Beginner–Intermediate',
        breakType: 'Beach break',
        consistency: 'High',
      },
      {
        name: 'Santa Rita',
        level: 'Intermediate',
        breakType: 'Reef / Beach',
        consistency: 'Medium',
      },
    ],
  },
  {
    name: 'Cascais',
    spots: [
      {
        name: 'Guincho',
        level: 'Intermediate–Advanced',
        breakType: 'Powerful Beach break',
        consistency: 'Very High',
      },
      {
        name: 'Carcavelos',
        level: 'Beginner–Advanced',
        breakType: 'Sandbar Beach break',
        consistency: 'Very High',
      },
      {
        name: 'São Pedro do Estoril',
        level: 'Intermediate',
        breakType: 'Reef break',
        consistency: 'Medium',
      },
      {
        name: 'Bafureira',
        level: 'Advanced',
        breakType: 'Reef break',
        consistency: 'Medium',
      },
    ],
  },
  {
    name: 'Costa da Caparica',
    spots: [
      {
        name: 'São João',
        level: 'Beginner–Intermediate',
        breakType: 'Beach break',
        consistency: 'High',
      },
      {
        name: 'CDS',
        level: 'Intermediate',
        breakType: 'Beach break',
        consistency: 'High',
      },
      {
        name: 'Paraíso',
        level: 'Beginner',
        breakType: 'Beach break',
        consistency: 'High',
      },
      {
        name: 'Riviera',
        level: 'Intermediate',
        breakType: 'Sandbar',
        consistency: 'Medium',
      },
      {
        name: 'Morena',
        level: 'Intermediate',
        breakType: 'Beach break',
        consistency: 'Medium',
      },
      {
        name: 'Bela Vista',
        level: 'Beginner–Intermediate',
        breakType: 'Beach break',
        consistency: 'High',
      },
      {
        name: 'Fonte da Telha',
        level: 'Beginner–Advanced',
        breakType: 'Beach break',
        consistency: 'Very High',
      },
    ],
  },
  {
    name: 'Sesimbra',
    spots: [
      {
        name: 'Meco',
        level: 'Intermediate',
        breakType: 'Beach break',
        consistency: 'Medium',
      },
      {
        name: 'Lagoa de Albufeira',
        level: 'Beginner–Intermediate',
        breakType: 'Beach break',
        consistency: 'Medium–High',
      },
      {
        name: 'Bicas',
        level: 'Intermediate',
        breakType: 'Beach break',
        consistency: 'Medium',
      },
    ],
  },
  {
    name: 'Alentejo',
    spots: [
      {
        name: 'São Torpes',
        level: 'Beginner–Intermediate',
        breakType: 'Beach break',
        consistency: 'High',
      },
      {
        name: 'Samoqueira',
        level: 'Intermediate',
        breakType: 'Reef / Beach',
        consistency: 'Medium',
      },
      {
        name: 'Malhão',
        level: 'Intermediate',
        breakType: 'Beach break',
        consistency: 'High',
      },
      {
        name: 'Odeceixe',
        level: 'Beginner–Intermediate',
        breakType: 'Rivermouth / Beach',
        consistency: 'Medium',
      },
    ],
  },
  {
    name: 'West Algarve',
    spots: [
      {
        name: 'Tonel',
        level: 'Intermediate–Advanced',
        breakType: 'Beach break',
        consistency: 'High',
      },
      {
        name: 'Beliche',
        level: 'Beginner–Intermediate',
        breakType: 'Sheltered Beach break',
        consistency: 'Medium–High',
      },
      {
        name: 'Zavial',
        level: 'Intermediate',
        breakType: 'Point / Reef',
        consistency: 'Medium',
      },
      {
        name: 'Cordoama',
        level: 'Beginner–Intermediate',
        breakType: 'Beach break',
        consistency: 'Very High',
      },
      {
        name: 'Castelejo',
        level: 'Intermediate',
        breakType: 'Beach break',
        consistency: 'High',
      },
      {
        name: 'Amado',
        level: 'Beginner–Intermediate',
        breakType: 'Beach break',
        consistency: 'Very High',
      },
      {
        name: 'Arrifana',
        level: 'Intermediate–Advanced',
        breakType: 'Point / Reef',
        consistency: 'High',
      },
      {
        name: 'Monte Clérigo',
        level: 'Beginner–Intermediate',
        breakType: 'Beach break',
        consistency: 'Medium',
      },
      {
        name: 'Amoreira',
        level: 'Beginner–Intermediate',
        breakType: 'Rivermouth',
        consistency: 'Medium',
      },
    ],
  },
  {
    name: 'South Algarve',
    spots: [
      {
        name: 'Porto de Mós',
        level: 'Beginner–Intermediate',
        breakType: 'Beach break',
        consistency: 'Low–Medium',
      },
    ],
  },
  {
    name: 'Madeira',
    spots: [
      {
        name: 'Jardim do Mar',
        level: 'Expert Only',
        breakType: 'Heavy Reef',
        consistency: 'Medium',
      },
      {
        name: 'Paul do Mar',
        level: 'Advanced–Expert',
        breakType: 'Reef break',
        consistency: 'Medium',
      },
      {
        name: 'São Vicente',
        level: 'Intermediate–Advanced',
        breakType: 'Reef break',
        consistency: 'Medium',
      },
    ],
  },
  {
    name: 'Azores',
    spots: [
      {
        name: 'Santa Bárbara',
        level: 'Intermediate–Advanced',
        breakType: 'Beach break',
        consistency: 'Very High',
      },
      {
        name: 'Monte Verde',
        level: 'Beginner–Intermediate',
        breakType: 'Beach break',
        consistency: 'High',
      },
      {
        name: 'Populo',
        level: 'Intermediate',
        breakType: 'Reef / Beach',
        consistency: 'Medium',
      },
    ],
  },
];

export const PORTUGAL_COUNTRY_CODE = 'PT';

export function portugalSeedTotals(): {
  regionCount: number;
  spotCount: number;
} {
  const regionCount = PORTUGAL_REGIONS.length;
  const spotCount = PORTUGAL_REGIONS.reduce(
    (n, r) => n + r.spots.length,
    0,
  );
  return { regionCount, spotCount };
}
