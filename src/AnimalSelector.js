import React from 'react';
import './styles.css';

function AnimalSelector({ animals, setAnimals }) {
  const [name, setName] = React.useState('');
  const [chosen, setChosen] = React.useState(animals);

  const addAnimal = () => {
    if (name && !animals.includes(name) && !chosen.includes(name)) {
      setAnimals([...animals, name]);
      setChosen([...chosen, name]);
      setName('');
    }
  };

  return (
    <div className="animal-selector">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Choose your animal name"
        className="input"
      />
      <button onClick={addAnimal} className="button">
        Add Animal
      </button>
      <div>
        <strong>Chosen animals: </strong>
        {chosen.map((a) => (
          <span key={a} className="animal">{a}</span>
        ))}
      </div>
    </div>
  );
}

export default AnimalSelector;
